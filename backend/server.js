// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { SpeechClient } from "@google-cloud/speech";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fetch from "node-fetch";

dotenv.config();

const app = express();
app.use(cors({ 
  origin: [
    "http://localhost:3000",
    "http://localhost:3001",
    "https://t-montes.github.io"
  ]
}));
app.use(express.json({ limit: "50mb" }));

// Request logging middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  if (req.body && Object.keys(req.body).length > 0) {
    // Log body but truncate large base64 audio content
    const logBody = { ...req.body };
    if (logBody.audioContentB64) {
      logBody.audioContentB64 = `[base64: ${logBody.audioContentB64.length} chars]`;
    }
    console.log('Request body:', JSON.stringify(logBody, null, 2));
  }
  if (req.query && Object.keys(req.query).length > 0) {
    console.log('Query params:', req.query);
  }
  next();
});

// ===== ENV =====
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
if (!GEMINI_KEY) console.warn("Missing GEMINI_API_KEY");
if (!ELEVEN_KEY || !ELEVEN_VOICE_ID) console.warn("Missing ELEVENLABS_* env vars");

// ===== Services =====
const speechClient = new SpeechClient(); // Google STT
const genAI = new GoogleGenerativeAI(GEMINI_KEY);

// ===== Per-conversation in-memory state =====
const chats = new Map();      // conversationId -> [{role, parts:[{text}]}...]
const tasksState = new Map(); // conversationId -> [{id, title, duration_minutes, complexity, start_time?}]
const draftsState = new Map();// conversationId -> [{id, to, subject, body}]
const MAX_TURNS = 20;

// ===== Mock user context (time, emails, calendar for tomorrow) =====
const tz = "America/Bogota";
function fmt(d) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).format(d);
}
function isoLocal(date, h, m) {
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}
function getMockContext() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);

  const medStart = isoLocal(new Date(tomorrow), 10, 0);
  const medEnd   = isoLocal(new Date(tomorrow), 11, 0);
  const octaStart = isoLocal(new Date(tomorrow), 14, 0);
  const octaEnd   = isoLocal(new Date(tomorrow), 16, 0);

  const calendarEvents = [
    {
      id: "evt-med-10am",
      title: "Dermatology checkup",
      location: "Clínica Santa María, Calle 70 #10-15, Bogotá",
      start: medStart,
      end: medEnd,
      travel_time_minutes_from_home: 60
    },
    {
      id: "evt-octa-2pm",
      title: "Client meeting: Octa",
      location: "Octa HQ, Av. 9 #123-45, Bogotá",
      start: octaStart,
      end: octaEnd
    }
  ];

  const emails = [
    {
      id: "em-001",
      from: "Dr. Valentina Ruiz <clinic@andes-med.co>",
      subject: "Reminder: appointment tomorrow 10:00",
      snippet: "Please arrive 10 min early. Bring ID and previous labs.",
      receivedAt: fmt(new Date(now.getTime() - 2 * 60 * 60 * 1000))
    },
    {
      id: "em-002",
      from: "María — Octa Procurement <maria@octa.com>",
      subject: "Agenda for tomorrow 2–4pm",
      snippet: "Let’s cover landing page scope, timeline, and handoff.",
      receivedAt: fmt(new Date(now.getTime() - 5 * 60 * 60 * 1000))
    }
  ];

  return {
    nowIso: now.toISOString(),
    nowHuman: fmt(now),
    timezone: tz,
    tomorrowIso: new Date(tomorrow.setHours(0,0,0,0)).toISOString(),
    emails,
    calendarEvents
  };
}

// ===== PROMPT: ask-first, natural conversation =====
const SYSTEM_PROMPT = `
You are a concise, pragmatic executive assistant. Your job is to help the user make progress with short, honest replies.

Default behavior:
- If the user states a goal (e.g., "I need to finish the landing page"), DO NOT create a task yet.
- First, ask for the missing minimum info (duration and preferred time window). Keep it <= 140 chars.
- Only create/schedule when the user explicitly asks to create/schedule OR has provided clear duration/time.

Two-turn rule:
- Turn 1: Clarify missing info (duration, time). If user lacks experience, propose a short estimate and ASK to confirm.
- Turn 2: After user confirms, create/update the task.

Conflicts & realism:
- If calendar conflicts exist, mention briefly and offer a workaround or prep. Never block; never argue.

Actions:
- "ask": when info is incomplete or confirmation is needed.
- "create_task": only after explicit confirmation or sufficient info (duration +/- time).
- "update_task": when user changes an existing task.
- "draft_email": when user asks for an email.

Output EXACTLY one JSON object (no markdown, no comments):
{
  "type": "ask" | "create_task" | "update_task" | "draft_email",
  "message_to_user": "string (<=140 chars, very direct)",
  "task": { "title": "string", "duration_minutes": number, "complexity": number, "start_time": "ISO optional" },
  "task_update": { "match_by":"id"|"title", "value":"string", "updates": { "title?":string, "duration_minutes?":number, "complexity?":number, "start_time?":string } },
  "email": { "to":"string", "subject":"string", "body":"string" }
}

Tone: brutally honest, but always forward-moving and concise.
`;

// ===== Helpers: server-side guardrail to stop premature task creation =====
function hasExplicitIntent(s = "") {
  const k = /(create|schedule|block|set|add|put|plan|book|slot|reserve|calendar|timebox)/i;
  return k.test(s);
}
function hasEnoughTimingInfo(action) {
  return action?.task?.duration_minutes && action.task.duration_minutes > 0;
}

// ===== /transcribe: audio -> STT -> transcript =====
app.post("/transcribe", async (req, res) => {
  try {
    const { audioContentB64, languageCode = "en-US" } = req.body || {};
    if (!audioContentB64) return res.status(400).json({ error: "Missing audioContentB64" });

    // STT using Google Cloud Speech
    // Use sample rate from client if provided, otherwise default to 48000
    const clientSampleRate = req.body.sampleRateHertz || 48000;
    const recognitionConfig = {
      encoding: "WEBM_OPUS",
      languageCode,
      enableAutomaticPunctuation: true,
      sampleRateHertz: clientSampleRate
    };
    console.log('Recognition config:', JSON.stringify(recognitionConfig));
    
    const [sttResp] = await speechClient.recognize({
      config: recognitionConfig,
      audio: { content: audioContentB64 }
    });
    
    const transcript = (sttResp.results || [])
      .map(r => r.alternatives?.[0]?.transcript || "")
      .join(" ")
      .trim();

    return res.json({ transcript });
  } catch (e) {
    console.error("Transcription error:", e);
    return res.status(500).json({ error: e.message || "Transcription failed" });
  }
});

// ===== /process: audio -> STT -> Gemini(JSON) -> guardrail -> apply -> TTS -> respond =====
app.post("/process", async (req, res) => {
  try {
    const { conversationId = "default", audioContentB64, languageCode = "en-US" } = req.body || {};
    if (!audioContentB64) return res.status(400).json({ error: "Missing audioContentB64" });

    // 1) STT
    const [sttResp] = await speechClient.recognize({
      config: { encoding: "WEBM_OPUS", languageCode, enableAutomaticPunctuation: true },
      audio: { content: audioContentB64 }
    });
    const transcript = (sttResp.results || []).map(r => r.alternatives?.[0]?.transcript || "").join(" ").trim();

    // 2) Build context bundle
    const ctx = getMockContext();
    const tasks = tasksState.get(conversationId) || [];
    const drafts = draftsState.get(conversationId) || [];

    // 3) Gemini 2.5 Pro — structured JSON response
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-pro",
      systemInstruction: SYSTEM_PROMPT,
      generationConfig: { responseMimeType: "application/json" }
    });

    const prev = chats.get(conversationId) || [];
    const contents = [
      ...prev,
      {
        role: "user",
        parts: [{
          text:
`NOW:${ctx.nowHuman} (${ctx.timezone})
Context emails:${JSON.stringify(ctx.emails)}
Context calendar_tomorrow:${JSON.stringify(ctx.calendarEvents)}
Current tasks:${JSON.stringify(tasks)}
User said:
${transcript || "(no speech detected)"}`
        }]
      }
    ];

    const gen = await model.generateContent({ contents });
    const raw = gen?.response?.text?.() || "{}";

    // 4) Parse action + apply guardrail
    let action;
    try { action = JSON.parse(raw); }
    catch { action = { type: "ask", message_to_user: "I couldn’t parse that. How many hours and when?" }; }

    // Guardrail: downgrade premature create_task to ask-first
    if (action?.type === "create_task") {
      const explicit = hasExplicitIntent(transcript);
      const enough = hasEnoughTimingInfo(action);
      if (!explicit && !enough) {
        action = { type: "ask", message_to_user: "How long should I block, and what time works?" };
      } else if (!action?.task?.duration_minutes) {
        action = { type: "ask", message_to_user: "How many hours should I block?" };
      }
    }

    // 5) Apply to in-memory state
    let updatedTasks = [...tasks];
    let updatedDrafts = [...drafts];

    if (action.type === "create_task" && action.task) {
      const id = `tsk_${Date.now()}`;
      updatedTasks.push({ id, ...action.task });
    } else if (action.type === "update_task" && action.task_update) {
      const { match_by, value, updates } = action.task_update;
      const idx = updatedTasks.findIndex(t => match_by === "id"
        ? t.id === value
        : (t.title || "").toLowerCase() === (value || "").toLowerCase());
      if (idx >= 0) updatedTasks[idx] = { ...updatedTasks[idx], ...updates };
      else action = { type: "ask", message_to_user: "I can’t find that task. Which one?" };
    } else if (action.type === "draft_email" && action.email) {
      const id = `em_draft_${Date.now()}`;
      updatedDrafts.push({ id, ...action.email });
    }

    tasksState.set(conversationId, updatedTasks.slice(-50));
    draftsState.set(conversationId, updatedDrafts.slice(-50));

    // Save chat turn: user text + model JSON (as text)
    const replyText = action.message_to_user || "OK.";
    let updatedChat = contents.concat([{ role: "model", parts: [{ text: JSON.stringify(action) }] }]);
    if (updatedChat.length > MAX_TURNS) updatedChat = updatedChat.slice(-MAX_TURNS);
    chats.set(conversationId, updatedChat);

    // 6) ElevenLabs TTS of the short reply
    const ttsUrl = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;
    const ttsReq = {
      method: "POST",
      headers: { "xi-api-key": ELEVEN_KEY, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({
        text: replyText,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.4, similarity_boost: 0.8, speed: 1.15 }
      })
    };
    const ttsResp = await fetch(ttsUrl, ttsReq);
    if (!ttsResp.ok) {
      const errTxt = await ttsResp.text().catch(() => "");
      throw new Error(`ElevenLabs TTS failed: ${ttsResp.status} ${errTxt}`);
    }
    const audioBuffer = Buffer.from(await ttsResp.arrayBuffer());
    const audioB64 = audioBuffer.toString("base64");

    // 7) Respond to client
    return res.json({
      conversationId,
      transcript,                 // user speech
      replyText,                  // short spoken line
      action,                     // JSON action (for UI/state)
      tasks: tasksState.get(conversationId),
      emailDrafts: draftsState.get(conversationId),
      audioB64,
      audioMime: "audio/mpeg"
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || "Internal error" });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Voice pipeline on :${port}`));
