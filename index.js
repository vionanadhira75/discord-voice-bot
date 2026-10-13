import 'dotenv/config';
import axios from 'axios';
import chalk from 'chalk';
import WebSocket from 'ws';

// Rotasi build number agar tidak statis — Discord track nilai ini
const BUILD_NUMBERS = [355048, 356138, 357063, 358152, 359000];
const CHROME_VERSIONS = ['128.0.0.0', '129.0.0.0', '130.0.0.0'];
const getRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];

class VoiceBot {
    constructor(token, channelId, selfMute = true, selfDeaf = true) {
        this.token = token;
        this.channelId = channelId;
        this.selfMute = selfMute;
        this.selfDeaf = selfDeaf;
        this.guildId = null;
        this.username = "Unknown";
        this.ws = null;
        this.heartbeatInterval = null;
        this.heartbeatTimer = null;
        this.seq = null;
        this.sessionId = null;
        this.baseUrl = "https://discord.com/api/v10";
        this.isReconnecting = false;

        // Randomize per-instance fingerprint agar setiap token punya identitas berbeda
        this.chromeVersion = getRandom(CHROME_VERSIONS);
        this.buildNumber = getRandom(BUILD_NUMBERS);
        this.userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${this.chromeVersion} Safari/537.36`;

        // Header HTTP lengkap yang dikirim browser nyata
        this.httpHeaders = {
            'Authorization': this.token,
            'User-Agent': this.userAgent,
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Origin': 'https://discord.com',
            'Referer': 'https://discord.com/channels/@me',
            'Sec-Ch-Ua': `"Chromium";v="${this.chromeVersion.split('.')[0]}", "Google Chrome";v="${this.chromeVersion.split('.')[0]}", "Not?A_Brand";v="99"`,
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"Windows"',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'X-Discord-Locale': 'en-US',
            'X-Discord-Timezone': 'Asia/Jakarta',
            'X-Super-Properties': this._buildSuperProperties(),
        };
    }

    _buildSuperProperties() {
        const props = {
            os: "Windows",
            browser: "Chrome",
            device: "",
            system_locale: "en-US",
            browser_user_agent: this.userAgent,
            browser_version: this.chromeVersion,
            os_version: "10",
            referrer: "",
            referring_domain: "",
            referrer_current: "",
            referring_domain_current: "",
            release_channel: "stable",
            client_build_number: this.buildNumber,
            client_event_source: null
        };
        // Base64 encode seperti yang dikirim client asli
        return Buffer.from(JSON.stringify(props)).toString('base64');
    }

    async getChannelGuild() {
        try {
            const response = await axios.get(`${this.baseUrl}/channels/${this.channelId}`, {
                headers: this.httpHeaders
            });
            this.guildId = response.data.guild_id;
            return this.guildId;
        } catch (error) {
            throw new Error(`Failed to get guild ID for channel ${this.channelId}: ${error.response?.data?.message || error.message}`);
        }
    }

    async getUsername() {
        try {
            const response = await axios.get(`${this.baseUrl}/users/@me`, {
                headers: this.httpHeaders
            });
            this.username = `${response.data.username}#${response.data.discriminator || '0000'}`;
            return this.username;
        } catch (error) {
            this.username = `Token-${this.token.slice(-6)}`;
            return this.username;
        }
    }

    async start() {
        try {
            await this.getUsername();
            await this.getChannelGuild();
            console.log(chalk.cyan(`[START] Bot [${this.username}] connecting to Voice Channel ${this.channelId} in Guild ${this.guildId}...`));
            this.connect();
        } catch (error) {
            console.error(chalk.red(`[ERROR] Failed to start bot for token ending in ...${this.token.slice(-6)}: ${error.message}`));
        }
    }

    connect() {
        this.isReconnecting = false;
        this.ws = new WebSocket('wss://gateway.discord.gg/?v=9&encoding=json');

        this.ws.on('open', () => {
            console.log(chalk.blue(`[WS] [${this.username}] Connection opened`));
        });

        this.ws.on('message', (data) => {
            try {
                const payload = JSON.parse(data.toString());
                const { op, t, d, s } = payload;

                if (s !== undefined && s !== null) {
                    this.seq = s;
                }

                switch (op) {
                    case 10: // Hello
                        this.heartbeatInterval = d.heartbeat_interval;
                        // Start heartbeat with a small initial random jitter
                        const initialJitter = Math.floor(Math.random() * (this.heartbeatInterval * 0.5));
                        setTimeout(() => {
                            this.sendHeartbeat();
                            this.startHeartbeat();
                        }, initialJitter);
                        this.identify();
                        break;
                    case 11: // Heartbeat ACK
                        break;
                    case 0: // Event Dispatch
                        if (t === 'READY') {
                            this.sessionId = d?.session_id || null;
                            console.log(chalk.green(`[SUCCESS] [${this.username}] Logged in successfully! (build: ${this.buildNumber})`));
                            this.joinVoice();
                        }
                        break;
                    case 1: // Heartbeat request
                        this.sendHeartbeat();
                        break;
                    case 9: // Invalid Session
                        console.log(chalk.red(`[WARNING] [${this.username}] Invalid session. Attempting reconnect...`));
                        this.reconnect();
                        break;
                    case 7: // Reconnect request
                        console.log(chalk.yellow(`[INFO] [${this.username}] Gateway requested reconnect...`));
                        this.reconnect();
                        break;
                }
            } catch (err) {
                console.error(chalk.red(`[ERROR] [${this.username}] Message parsing error: ${err.message}`));
            }
        });

        this.ws.on('close', (code, reason) => {
            console.log(chalk.red(`[CLOSED] [${this.username}] Connection closed (Code: ${code}, Reason: ${reason || 'None'}). Reconnecting in 5s...`));
            this.cleanup();
            if (!this.isReconnecting) {
                this.isReconnecting = true;
                setTimeout(() => this.connect(), 5000);
            }
        });

        this.ws.on('error', (error) => {
            console.error(chalk.red(`[ERROR] [${this.username}] WebSocket error: ${error.message}`));
        });
    }

    startHeartbeat() {
        this.cleanupHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            this.sendHeartbeat();
        }, this.heartbeatInterval);
    }

    sendHeartbeat() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                op: 1,
                d: this.seq
            }));
        }
    }

    identify() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const payload = {
                op: 2,
                d: {
                    token: this.token,
                    capabilities: 30717,
                    properties: {
                        os: "Windows",
                        browser: "Chrome",
                        device: "",
                        system_locale: "en-US",
                        browser_user_agent: this.userAgent,
                        browser_version: this.chromeVersion,
                        os_version: "10",
                        referrer: "",
                        referring_domain: "",
                        referrer_current: "",
                        referring_domain_current: "",
                        release_channel: "stable",
                        client_build_number: this.buildNumber,
                        client_event_source: null
                    },
                    presence: {
                        status: "online",
                        since: 0,
                        activities: [],
                        afk: false
                    },
                    compress: false,
                    client_state: {
                        guild_versions: {},
                        highest_last_message_id: "0",
                        read_states_version: 0,
                        user_guild_settings_version: -1,
                        user_settings_version: -1,
                        private_channels_version: "0",
                        api_code_version: 0
                    }
                }
            };
            this.ws.send(JSON.stringify(payload));
        }
    }

    joinVoice() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            console.log(chalk.magenta(`[VOICE] [${this.username}] Joining Voice Channel ${this.channelId} in Guild ${this.guildId} (Muted: ${this.selfMute}, Deafened: ${this.selfDeaf})...`));
            const payload = {
                op: 4,
                d: {
                    guild_id: this.guildId,
                    channel_id: this.channelId,
                    self_mute: this.selfMute,
                    self_deaf: this.selfDeaf
                }
            };
            this.ws.send(JSON.stringify(payload));
        }
    }

    cleanupHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    cleanup() {
        this.cleanupHeartbeat();
        if (this.ws) {
            this.ws.terminate();
            this.ws = null;
        }
    }

    reconnect() {
        if (!this.isReconnecting) {
            this.isReconnecting = true;
            this.cleanup();
            setTimeout(() => this.connect(), 1000);
        }
    }
}

async function main() {
    const tokens = process.env.TOKENS ? process.env.TOKENS.split(',').map(t => t.trim()).filter(Boolean) : [];
    const channelIds = process.env.CHANNEL_IDS ? process.env.CHANNEL_IDS.split(',').map(c => c.trim()).filter(Boolean) : [];
    const tokenDelaySetting = parseInt(process.env.TOKEN_DELAY, 10) || 5;

    if (tokens.length === 0) {
        console.error(chalk.red("[ERROR] No tokens found in TOKENS variable in .env file!"));
        process.exit(1);
    }

    if (channelIds.length === 0) {
        console.error(chalk.red("[ERROR] No channel IDs found in CHANNEL_IDS variable in .env file!"));
        process.exit(1);
    }

    console.log(chalk.green(`[INFO] Loaded ${tokens.length} tokens and ${channelIds.length} voice channels from .env.`));
    console.log(chalk.green(`[INFO] Connecting accounts sequentially with anti-detection delays...`));

    const selfMute = process.env.SELF_MUTE !== 'false';
    const selfDeaf = process.env.SELF_DEAF !== 'false';

    const bots = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const channelId = channelIds[i % channelIds.length];
        
        const bot = new VoiceBot(token, channelId, selfMute, selfDeaf);
        bots.push(bot);
        bot.start();

        if (i < tokens.length - 1) {
            // Jitter lebih lebar: antara 3s - 12s dari TOKEN_DELAY setting
            // Pola manusiawi: sesekali delay lebih panjang (simulasi jeda natural)
            const baseDelay = tokenDelaySetting * 1000;
            const jitter = (Math.random() * 6000) - 3000;
            const humanPause = Math.random() < 0.2 ? Math.random() * 8000 : 0; // 20% chance extra long pause
            const delay = Math.max(3000, baseDelay + jitter + humanPause);
            console.log(chalk.gray(`[DELAY] Waiting ${(delay / 1000).toFixed(2)}s before next connection...`));
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    console.log(chalk.green(`[INFO] All bots initialization started. They will remain connected to the Voice Channels.`));
    
    process.on('SIGINT', () => {
        console.log(chalk.yellow('\n[SHUTDOWN] Terminating all bot connections...'));
        for (const bot of bots) {
            bot.cleanup();
        }
        process.exit(0);
    });
}

main().catch(error => {
    console.error(chalk.red(`[CRITICAL ERROR] ${error.name}: ${error.message}`));
});
