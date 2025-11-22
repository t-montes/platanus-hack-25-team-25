import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || process.env.ELEVENLABS_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || process.env.ELEVENLABS_VOICE_ID;

app.use(express.json());
app.use(express.static("public"));
app.use(cors());

let chatHistory = [];
const MAX_TURNS = 20;

const SYSTEM_PROMPT = `CRITICAL INSTRUCTION - JSON FORMAT REQUIRED:
You MUST respond ONLY with valid JSON. Never respond with plain text.
Every response must use this exact format:
{"text": "your response in spanish", "command": "command_if_needed"}

If no command is needed, omit the command field:
{"text": "your response in spanish"}

EXAMPLES:
User: "dragón" or "quiero un dragón" or "pon un dragón"
Response: {"text": "¡Genial! Te traigo un dragón. ¿Quieres aprender a moverlo?", "command": "dragon"}

User: "hola" or "¿cómo estás?"
Response: {"text": "¡Hola! ¿Qué quieres crear hoy?"}

User: "¿qué puedo hacer?"
Response: {"text": "¡Puedes decir arrastrar, rotar, escalar o animar! ¿Qué quieres probar?"}

---

ROLE: Eres un maestro amigable y entusiasta ayudando a un niño a explorar una plataforma de mundo virtual creativo.

PLATFORM FEATURES:
- ARRASTRAR: Di "arrastrar" para mover objetos con una mano
- ROTAR: Di "rotar" para girar objetos con una mano
- ESCALAR: Di "escalar" para hacer más grande o pequeño con ambas manos
- ANIMACIÓN: Di "animación" para ver animaciones

AVAILABLE OBJECTS:
- DRAGÓN: When user mentions "dragón" or "dragon" or asks to add it, you MUST include "command": "dragon" in your JSON response

GUIDELINES:
- Keep responses SHORT (max 1-2 sentences, under 100 words)
- Be energetic and encouraging
- Use simple language for kids
- ALWAYS respond in SPANISH (inside the JSON "text" field)
- DO NOT repeat context info unless asked
- If user asks for unavailable items, suggest the dragon
- End with engaging follow-up question

REMEMBER: EVERY response must be valid JSON with "text" field in Spanish, and optionally "command" field.`;


// /speak: text -> Gemini -> TTS -> return audio
app.post("/speak", async (req, res) => {
  try {
    const { text, sceneContext } = req.body || {};
    console.log('=== /speak endpoint called ===');
    console.log('User text:', text);
    console.log('Scene context:', JSON.stringify(sceneContext, null, 2));
    
    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Missing text" });
    }

    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "Gemini API not configured" });
    }

    if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) {
      return res.status(500).json({ error: "ElevenLabs API not configured" });
    }

    let userMessage = text.trim();
    if (sceneContext) {
      const contextInfo = [];
      if (sceneContext.character) {
        contextInfo.push(`Personaje actual: ${sceneContext.character}`);
      }
      if (sceneContext.background) {
        contextInfo.push(`Fondo actual: ${sceneContext.background}`);
      }
      if (sceneContext.objects && sceneContext.objects.length > 0) {
        contextInfo.push(`Objetos en escena: ${sceneContext.objects.join(', ')}`);
      } else {
        contextInfo.push(`Objetos en escena: ninguno`);
      }
      
      userMessage = `[CONTEXTO: ${contextInfo.join(' | ')}]\n\nUsuario dice: ${text.trim()}`;
    }
    
    console.log('Message to Gemini:', userMessage);

    // 1) Call Gemini API
    chatHistory.push({
      role: "user",
      parts: [{ text: userMessage }]
    });

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${GEMINI_API_KEY}`;
    const geminiPayload = {
      contents: chatHistory,
      systemInstruction: {
        parts: [{ text: SYSTEM_PROMPT }]
      },
      generationConfig: {
        temperature: 0.8,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 150,
        responseMimeType: "application/json"
      }
    };

    const geminiResp = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiPayload)
    });

    if (!geminiResp.ok) {
      const errTxt = await geminiResp.text().catch(() => "");
      throw new Error(`Gemini API failed: ${geminiResp.status} ${errTxt}`);
    }

    const geminiData = await geminiResp.json();
    let rawReply = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '{"text": "¡Estoy aquí para ayudar! ¿Qué te gustaría explorar?"}';

    console.log('Raw Gemini response:', rawReply);

    let replyText = "¡Estoy aquí para ayudar!";
    let command = null;

    try {
      let jsonToParse = rawReply.trim();
      if (!jsonToParse.startsWith('{')) {
        const jsonMatch = rawReply.match(/\{[\s\S]*\}/);
        console.log('JSON match found:', jsonMatch ? jsonMatch[0] : 'none');
        if (jsonMatch) {
          jsonToParse = jsonMatch[0];
        } else {
          throw new Error('No JSON found in response');
        }
      }
      
      const parsed = JSON.parse(jsonToParse);
      console.log('Parsed JSON:', JSON.stringify(parsed, null, 2));
      
      if (parsed.text) {
        replyText = parsed.text;
        command = parsed.command || null;
        console.log('Extracted text:', replyText);
        console.log('Extracted command:', command);
      } else {
        console.warn('JSON parsed but no "text" field found');
        replyText = rawReply;
      }
    } catch (e) {
      console.log("Failed to parse JSON, treating as plain text:", e.message);
      replyText = rawReply;
    }

    if (!command) {
      const userTextLower = text.toLowerCase();
      const contextStr = JSON.stringify(sceneContext).toLowerCase();
      const hasDragonInScene = contextStr.includes('dragón') || contextStr.includes('dragon');
      
      if ((userTextLower.includes('dragón') || userTextLower.includes('dragon')) && !hasDragonInScene) {
        console.log('FALLBACK: User mentioned dragon, adding command automatically');
        command = 'dragon';
      }
    }

    // 2) Update chat history with model response (store the text part only)
    chatHistory.push({
      role: "model",
      parts: [{ text: replyText }]
    });

    // Keep history within MAX_TURNS
    if (chatHistory.length > MAX_TURNS * 2) {
      chatHistory = chatHistory.slice(-MAX_TURNS * 2);
    }

    // 3) ElevenLabs TTS with Gemini response (only the text part)
    const ttsUrl = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;
    const ttsResp = await fetch(ttsUrl, {
      method: "POST",
      headers: { 
        "xi-api-key": ELEVEN_API_KEY, 
        "Content-Type": "application/json", 
        Accept: "audio/mpeg" 
      },
      body: JSON.stringify({
        text: replyText.trim(),
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.4, similarity_boost: 0.8, speed: 1.15 }
      })
    });

    if (!ttsResp.ok) {
      const errTxt = await ttsResp.text().catch(() => "");
      throw new Error(`ElevenLabs TTS failed: ${ttsResp.status} ${errTxt}`);
    }

    const audioBuffer = Buffer.from(await ttsResp.arrayBuffer());
    const audioB64 = audioBuffer.toString("base64");

    const response = {
      audioB64,
      audioMime: "audio/mpeg",
      replyText
    };

    if (command) {
      response.command = command;
    }

    console.log('Response being sent to frontend:', {
      hasAudio: !!response.audioB64,
      replyText: response.replyText,
      command: response.command
    });
    console.log('=== End of /speak request ===\n');

    return res.json(response);
  } catch (e) {
    console.error("Speak error:", e);
    return res.status(500).json({ error: e.message || "Internal error" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
