export class PushToTalkManager {
    constructor(backendUrl, conversationId, onStateChange, onTranscript, onResponse) {
        this.backendUrl = backendUrl;
        this.conversationId = conversationId;
        this.onStateChange = onStateChange;
        this.onTranscript = onTranscript;
        this.onResponse = onResponse;
        
        this.state = 'idle';
        this.mediaRecorder = null;
        this.audioChunks = [];
        this.mediaStream = null;
        this.isSpacePressed = false;
        this.isProcessing = false;
        this.currentMimeType = null;
        this.audioContext = null;
        this.analyser = null;
        this.recordingStartTime = null;
        
        this._initializeKeyListeners();
    }

    async initialize() {
        try {
            this.mediaStream = await navigator.mediaDevices.getUserMedia({ 
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    sampleRate: 48000,
                    channelCount: 1
                }
            });
            
            console.log('Microphone access granted');
            
            const audioTrack = this.mediaStream.getAudioTracks()[0];
            const settings = audioTrack.getSettings();
            console.log('Audio track settings:', settings);
            
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.analyser = this.audioContext.createAnalyser();
            const source = this.audioContext.createMediaStreamSource(this.mediaStream);
            source.connect(this.analyser);
            this.analyser.fftSize = 256;
            
            return true;
        } catch (err) {
            console.error('Microphone permission denied:', err);
            return false;
        }
    }

    _initializeKeyListeners() {
        document.addEventListener('keydown', (e) => {
            if (e.code === 'Space' && !e.repeat && !this.isSpacePressed && !this.isProcessing) {
                e.preventDefault();
                this._startRecording();
            }
        });

        document.addEventListener('keyup', (e) => {
            if (e.code === 'Space' && this.isSpacePressed) {
                e.preventDefault();
                this._stopRecording();
            }
        });
    }

    _startRecording() {
        if (!this.mediaStream) {
            console.error('Media stream not initialized');
            return;
        }

        this.isSpacePressed = true;
        this.audioChunks = [];
        
        const mimeTypes = [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/ogg;codecs=opus',
            'audio/mp4'
        ];
        
        let selectedMimeType = null;
        for (const mimeType of mimeTypes) {
            if (MediaRecorder.isTypeSupported(mimeType)) {
                selectedMimeType = mimeType;
                console.log('✅ Using MIME type:', mimeType);
                break;
            } else {
                console.log('❌ Not supported:', mimeType);
            }
        }
        
        if (!selectedMimeType) {
            console.error('No supported audio MIME type found');
            this.isSpacePressed = false;
            return;
        }
        
        const options = {
            mimeType: selectedMimeType,
            audioBitsPerSecond: 128000
        };

        try {
            this.mediaRecorder = new MediaRecorder(this.mediaStream, options);
            this.currentMimeType = selectedMimeType;
        } catch (e) {
            console.error('MediaRecorder creation failed:', e);
            this.isSpacePressed = false;
            return;
        }

        this.mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                console.log('Audio chunk received:', event.data.size, 'bytes');
                this.audioChunks.push(event.data);
            }
        };

        this.mediaRecorder.onstop = () => {
            console.log('MediaRecorder stopped, total chunks:', this.audioChunks.length);
            this._processRecording();
        };

        this.mediaRecorder.onerror = (event) => {
            console.error('MediaRecorder error:', event.error);
        };

        this.recordingStartTime = Date.now();
        this.mediaRecorder.start(100);
        this._setState('listening');
        console.log('🎤 Recording started at', new Date().toLocaleTimeString());
        console.log('   State:', this.mediaRecorder.state);
        console.log('   MIME:', this.currentMimeType);
        console.log('   Bitrate:', options.audioBitsPerSecond);
        
        if (this.analyser) {
            this._checkAudioLevel();
        }
    }

    _stopRecording() {
        if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
            const duration = Date.now() - this.recordingStartTime;
            console.log('🛑 Recording stopped after', duration, 'ms');
            
            if (duration < 500) {
                console.warn('⚠️  Recording too short (', duration, 'ms) - may not contain speech');
            }
            
            this.mediaRecorder.stop();
            this.isSpacePressed = false;
        }
    }

    async _processRecording() {
        if (this.audioChunks.length === 0) {
            console.warn('❌ No audio chunks recorded');
            this._setState('idle');
            return;
        }

        console.log('📦 Processing', this.audioChunks.length, 'audio chunks');
        console.log('📦 Using MIME type:', this.currentMimeType);

        this._setState('processing');
        this.isProcessing = true;

        // CRITICAL: Use the actual MIME type from the MediaRecorder!
        const audioBlob = new Blob(this.audioChunks, { type: this.currentMimeType || 'audio/webm;codecs=opus' });
        console.log('✅ Audio blob created:', {
            size: audioBlob.size,
            type: audioBlob.type,
            chunks: this.audioChunks.length
        });
        
        if (audioBlob.size < 1000) {
            console.error('❌ Audio blob too small (', audioBlob.size, 'bytes) - likely no audio captured');
            this._setState('idle');
            this.isProcessing = false;
            return;
        }
        
        const reader = new FileReader();
        reader.onloadend = async () => {
            const base64Audio = reader.result.split(',')[1];
            console.log('📤 Base64 audio length:', base64Audio.length);
            
            try {
                await this._sendToBackend(base64Audio);
            } catch (error) {
                console.error('❌ Error processing audio:', error);
                this._setState('idle');
                this.isProcessing = false;
            }
        };
        
        reader.readAsDataURL(audioBlob);
    }

    async _sendToBackend(audioContentB64) {
        try {
            console.log('Sending audio to backend...');
            console.log('MIME type:', this.currentMimeType);
            const response = await fetch(`${this.backendUrl}/process`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    audioContentB64,
                    languageCode: 'es-ES',
                    conversationId: this.conversationId,
                    sceneContext: this._getSceneContext(),
                    audioMimeType: this.currentMimeType
                })
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                const errorMsg = errorData.error || `Backend error: ${response.status}`;
                console.error('❌ Backend error:', errorMsg);
                throw new Error(errorMsg);
            }

            const data = await response.json();
            console.log('✅ Backend response received');
            console.log('   Has audio:', !!data.audioB64);
            console.log('   Transcript:', data.transcript);
            console.log('   Reply text:', data.replyText);

            if (this.onTranscript && data.transcript) {
                this.onTranscript(data.transcript);
            }

            if (data.audioB64) {
                this._setState('talking');
                
                const audioSrc = `data:${data.audioMime || 'audio/mpeg'};base64,${data.audioB64}`;
                console.log('Playing audio, src length:', audioSrc.length);
                const audio = new Audio(audioSrc);
                
                audio.onended = () => {
                    console.log('Audio playback ended');
                    this._setState('idle');
                    this.isProcessing = false;
                };

                audio.onerror = (e) => {
                    console.error('Audio playback error:', e);
                    console.error('Audio element error:', audio.error);
                    this._setState('idle');
                    this.isProcessing = false;
                };

                audio.onloadeddata = () => {
                    console.log('Audio loaded successfully');
                };

                try {
                    await audio.play();
                    console.log('Audio play() called successfully');
                } catch (playError) {
                    console.error('Audio play() failed:', playError);
                    this._setState('idle');
                    this.isProcessing = false;
                }

                if (this.onResponse) {
                    this.onResponse(data);
                }
            } else {
                console.warn('No audio in response');
                this._setState('idle');
                this.isProcessing = false;
            }

        } catch (error) {
            console.error('Error sending to backend:', error);
            this._setState('idle');
            this.isProcessing = false;
            throw error;
        }
    }

    _getSceneContext() {
        return window.gameSceneContext || {
            character: null,
            background: null,
            objects: []
        };
    }

    _setState(newState) {
        if (this.state !== newState) {
            console.log(`State change: ${this.state} -> ${newState}`);
            this.state = newState;
            if (this.onStateChange) {
                this.onStateChange(newState);
            }
        }
    }

    _checkAudioLevel() {
        if (!this.analyser || !this.isSpacePressed) return;
        
        const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
        this.analyser.getByteFrequencyData(dataArray);
        
        const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
        const level = Math.round(average);
        
        if (level < 5) {
            console.log('🔇 Audio level:', level, '(VERY LOW - mic might be muted or too far)');
        } else if (level < 20) {
            console.log('🔉 Audio level:', level, '(low - speak louder)');
        } else {
            console.log('🔊 Audio level:', level, '(good)');
        }
        
        if (this.isSpacePressed) {
            setTimeout(() => this._checkAudioLevel(), 500);
        }
    }

    destroy() {
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(track => track.stop());
        }
        if (this.audioContext) {
            this.audioContext.close();
        }
        this.mediaRecorder = null;
        this.mediaStream = null;
        this.audioContext = null;
        this.analyser = null;
    }
}

