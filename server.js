const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const DIR = __dirname;
const PORT = process.env.PORT || 8099;

let addonOptions = {};
try { addonOptions = JSON.parse(fs.readFileSync('/data/options.json', 'utf8')); } catch(e) {}

let sanitizedHaUrl = addonOptions.ha_wss_url || "http://supervisor/core/api";
if (sanitizedHaUrl) {
  sanitizedHaUrl = sanitizedHaUrl.replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://');
  sanitizedHaUrl = sanitizedHaUrl.replace(/\/api\/websocket\/?$/i, '/api');
  if (!sanitizedHaUrl.endsWith('/api')) sanitizedHaUrl = sanitizedHaUrl.replace(/\/$/, '') + '/api';
}

const HA_URL = sanitizedHaUrl;
const HA_TOKEN = addonOptions.long_live_token || process.env.SUPERVISOR_TOKEN;
console.log("TOKEN:", HA_TOKEN ? "EXISTS" : "MISSING");

const OAI_KEY = "REPLACE OPEN AI KEY";
const OAI_MODEL = "gpt-4o-mini";

// FTP Configuration
const FTP_CONFIG = {
  host: addonOptions.ftp_ip,
  port: addonOptions.ftp_port,
  user: addonOptions.ftp_user,
  password: addonOptions.ftp_password,
  remotePath: '/config/www/community/images'
};

const HISTORY_FILE = path.join(DIR, 'history.json');
const SCHEDULE_FILE = path.join(DIR, 'schedule.json');
const MEMORY_FILE = path.join(DIR, 'memory.json');
const CHATHISTORY_FILE = path.join(DIR, 'chathistory.json');

// Ensure json files exist
try { if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, '[]'); } catch (_) {}
try { if (!fs.existsSync(SCHEDULE_FILE)) fs.writeFileSync(SCHEDULE_FILE, '[]'); } catch (_) {}
try { if (!fs.existsSync(MEMORY_FILE)) fs.writeFileSync(MEMORY_FILE, JSON.stringify({rooms: {}, ac: {}})); } catch (_) {}
try { if (!fs.existsSync(CHATHISTORY_FILE)) fs.writeFileSync(CHATHISTORY_FILE, '{}'); } catch (_) {}

// Ensure local audio directory exists
const LOCAL_AUDIO_PATH = '/config/www/community/images';
try {
  if (!fs.existsSync(LOCAL_AUDIO_PATH)) {
    fs.mkdirSync(LOCAL_AUDIO_PATH, { recursive: true });
  }
} catch (e) {
  console.log('Using fallback local path for audio');
}

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav'
};

// State
let PENDING_REPEAT = null;
let SC_TIMERS = {};

const os = require('os');
const LICENSE_KEY = addonOptions.license_key || process.env.LICENSE_KEY || "";
const FB_URL = "https://lumi-ai-license-default-rtdb.firebaseio.com";
const FB_KEY = "AIzaSyC9a8q2A2YCoxyJsOXUfrUR4mWFP7qvpkQ";

function getMacAddress() {
  const ifaces = os.networkInterfaces();
  for (let name of Object.keys(ifaces)) {
    for (let iface of ifaces[name]) {
      if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
        return iface.mac;
      }
    }
  }
  return "UNKNOWN_MAC_" + Math.random().toString(36).substr(2, 9);
}
const MAC_ID = getMacAddress();

let IS_LICENSED = false;
let LICENSE_MSG = "Checking license...";

async function maintainLicenseLock() {
  if (!LICENSE_KEY) {
    LICENSE_MSG = "Please enter your provided License Key in the Addon Configuration!";
    IS_LICENSED = false;
    return;
  }
  
  const url = `${FB_URL.replace(/\/$/, '')}/licenses/${LICENSE_KEY}.json?auth=${FB_KEY}`;
  
  try {
    const res = await fetch(url);
    const data = await res.json();
    
    if (data && data.error) {
       IS_LICENSED = false;
       LICENSE_MSG = "Firebase API Key is Invalid or Permissions Denied.";
       return;
    }
    
    if (!data) {
      IS_LICENSED = false;
      LICENSE_MSG = "License key does not exist or has been revoked!";
      return;
    }
    
    const now = Date.now();
    if (data.active_session) {
      const isMe = data.active_session.mac === MAC_ID;
      const isRecent = (now - data.active_session.last_seen) < 90000;
      if (!isMe && isRecent) {
        IS_LICENSED = false;
        LICENSE_MSG = "License key is currently in use by another running addon instance!";
        return;
      }
    }
    
    const patchUrl = `${FB_URL.replace(/\/$/, '')}/licenses/${LICENSE_KEY}/active_session.json?auth=${FB_KEY}`;
    await fetch(patchUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mac: MAC_ID, last_seen: now })
    });
    
    IS_LICENSED = true;
    LICENSE_MSG = "License Active";
  } catch(e) {
    console.error("License check error:", e.message);
  }
}

maintainLicenseLock();
setInterval(maintainLicenseLock, 30000);


// --- UTILS ---
function readJson(fp) { 
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } 
  catch { 
    if (fp === MEMORY_FILE) return { rooms: {} };
    if (fp === CHATHISTORY_FILE) return {};
    return []; 
  } 
}
function writeJson(fp, d) { fs.writeFileSync(fp, JSON.stringify(d, null, 2)); }

function getIstTimeStr(d) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(d || new Date());
}

function logAction(device, actionStr, rawCmd) {
  const h = readJson(HISTORY_FILE);
  const t = new Date();
  const devName = Array.isArray(device) ? device.join(', ') : String(device);
  h.push({ device: devName.toLowerCase(), action: actionStr.toUpperCase(), timestamp: t.toISOString(), rawCmd });
  if (h.length > 2000) h.shift();
  writeJson(HISTORY_FILE, h);
}

// --- FTP UPLOAD FUNCTION ---
async function uploadToFTP(buffer, filename) {
  return new Promise((resolve, reject) => {
    const ftp = require('ftp');
    const client = new ftp();
    
    client.on('ready', () => {
      client.cwd(FTP_CONFIG.remotePath, (err) => {
        if (err) {
          client.mkdir(FTP_CONFIG.remotePath, true, () => {
            client.cwd(FTP_CONFIG.remotePath, (err2) => {
              if (err2) {
                client.end();
                reject(err2);
                return;
              }
              uploadFile();
            });
          });
        } else {
          uploadFile();
        }
      });
      
      function uploadFile() {
        client.put(buffer, filename, (err) => {
          client.end();
          if (err) reject(err);
          else resolve();
        });
      }
    });
    
    client.on('error', reject);
    client.connect(FTP_CONFIG);
  });
}

// --- AUDIO CONVERSION: WAV to MP3 ---
async function convertWavToMp3(wavBuffer) {
  return new Promise((resolve, reject) => {
    const tempWav = path.join('/tmp', `recording_${Date.now()}.wav`);
    const tempMp3 = path.join('/tmp', `recording_${Date.now()}.mp3`);
    
    // Write WAV to temp file
    fs.writeFileSync(tempWav, wavBuffer);
    
    // Convert using ffmpeg
    exec(`ffmpeg -i ${tempWav} -acodec libmp3lame -ab 128k -ar 16000 -ac 1 ${tempMp3} -y`, (error) => {
      if (error) {
        console.log('ffmpeg error, falling back to direct WAV:', error.message);
        // Fallback: just copy the WAV as MP3
        fs.writeFileSync(tempMp3, wavBuffer);
      }
      
      try {
        const mp3Buffer = fs.readFileSync(tempMp3);
        // Cleanup
        try { fs.unlinkSync(tempWav); } catch(e) {}
        try { fs.unlinkSync(tempMp3); } catch(e) {}
        resolve(mp3Buffer);
      } catch (e) {
        reject(e);
      }
    });
  });
}

// --- HA API ---
async function callSvc(domain, service, data) {
  const r = await fetch(`${HA_URL}/services/${domain}/${service}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`HA Error ${r.status}: ${errText}`);
  }
  const text = await r.text();
  try { return text ? JSON.parse(text) : {}; } catch(e) { return {}; }
}

function getEnergyContext() {
    try {
        const energyDir = fs.existsSync('/data/options.json') ? '/config/energy_monitor' : path.join(DIR, '../Energy Monitoring/data');
        const dailyFile = path.join(energyDir, 'daily_usage.json');
        const devicesFile = path.join(energyDir, 'devices.json');
        
        if (!fs.existsSync(dailyFile) || !fs.existsSync(devicesFile)) return "";
        
        const dailyData = JSON.parse(fs.readFileSync(dailyFile, 'utf8'));
        const devicesData = JSON.parse(fs.readFileSync(devicesFile, 'utf8'));
        
        const deviceMap = {};
        (devicesData.devices || []).forEach(d => { deviceMap[d.entity] = d.name || d.entity; });
        const rate = (devicesData.currentPricing && devicesData.currentPricing.rate) || 0;
        
        const dates = Object.keys(dailyData).sort((a,b)=>b.localeCompare(a));
        if(dates.length === 0) return "";
        
        const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()); 
        
        let todayUnits = 0;
        let d7Units = 0;
        let d30Units = 0;
        
        const device30 = {};
        const device7 = {};
        const deviceToday = {};
        
        let dailyBreakdown = '';
        let count = 0;
        
        const nowMs = Date.now();
        const d7Ms = nowMs - 7*86400*1000;
        const d30Ms = nowMs - 30*86400*1000;
        
        for (const date of dates) {
            const dateObj = new Date(date + "T00:00:00+05:30");
            const dateMs = dateObj.getTime();
            const units = dailyData[date].total_units || 0;
            
            if (date === todayStr || dateMs >= nowMs - 86400*1000) { 
                todayUnits += units; 
                Object.entries(dailyData[date].devices || {}).forEach(([e, d]) => {
                    deviceToday[e] = (deviceToday[e]||0) + (d.units||0);
                });
            }
            if (dateMs >= d7Ms) { 
                d7Units += units; 
                Object.entries(dailyData[date].devices || {}).forEach(([e, d]) => {
                    device7[e] = (device7[e]||0) + (d.units||0);
                });
            }
            if (dateMs >= d30Ms) { 
                d30Units += units; 
                Object.entries(dailyData[date].devices || {}).forEach(([e, d]) => {
                    device30[e] = (device30[e]||0) + (d.units||0);
                });
            }
            
            if (count < 7) {
                dailyBreakdown += `\n${date}: ${units.toFixed(2)} kWh`;
                count++;
            }
        }
        
        function getTop3(devMap) {
            const arr = Object.entries(devMap).sort((a,b)=>b[1]-a[1]).slice(0,3);
            if (!arr.length) return 'None';
            return arr.map((x, i) => `${i+1}. ${deviceMap[x[0]]||x[0]} (${x[1].toFixed(2)} kWh)`).join(', ');
        }
        
        return `
ENERGY MONITORING STATS (Use this to answer questions about power/energy usage)
Current Rate: ₹${rate}/kWh
Today (${todayStr}): ${todayUnits.toFixed(2)} kWh (₹${(todayUnits*rate).toFixed(2)})
Today's Top Devices: ${getTop3(deviceToday)}
Last 7 Days: ${d7Units.toFixed(2)} kWh (₹${(d7Units*rate).toFixed(2)})
7-Day Top Devices: ${getTop3(device7)}
Last 30 Days: ${d30Units.toFixed(2)} kWh (₹${(d30Units*rate).toFixed(2)})
30-Day Top Devices: ${getTop3(device30)}
Recent Daily History:${dailyBreakdown}
* To answer queries about specific dates, refer to the "Recent Daily History".`;
    } catch(e) {
        console.log("Energy context error:", e.message);
        return "";
    }
}

function buildPrompt(entsStr, energyStatsStr = "") {
  const mem = readJson(MEMORY_FILE);
  return `You are Lumi, a smart home AI assistant.
Your owner is "Boss". Always call the user "Boss".
You must behave like a HUMAN assistant, not just execute commands.
CORE BEHAVIOR
1. Understand intent (not just keywords)
2. Handle indirect sentences naturally
3. Ask smart follow up questions before actions
4. Use memory of rooms and devices
5. Confirm before critical actions
6. Maintain short conversation memory
CONTEXT AWARE INTELLIGENCE
If user says: "I am cold"
DO NOT execute directly
Ask: "Boss, I think you might want me to turn off the AC. Should I do that?"
If user says: "I am hot"
Ask: "Boss, should I turn on the AC for you?"
If user says: "Too bright"
Ask: "Boss, which room are you in?"
If user gives room:
Ask: "Boss, would you like me to reduce the brightness?"
If user says YES: Reduce brightness
ROOM UNDERSTANDING
Use: 1. Learned memory 2. Entity names
If room missing ALWAYS ask
CONVERSATION MEMORY
Maintain flow: User AI User AI EXECUTE
FOLLOW UP ACTION SYSTEM
If AI asked and user says: "yes", "ok", "do it"
Execute last suggested action
If user says "no" Cancel
LEARNING MODE (ADVANCED)
If user teaches something, you MUST return a strict JSON payload with the 'learn' parameter:
ROOM ALIAS:
"mohan room means experience room"
Return: {"learn":{"type":"room_alias","alias":"mohan room","target":"experience room"},"chat":"Got it boss, mohan room is the experience room."}
ROOM DEVICE W/ SUBCATEGORY (Works for lights, covers, sensors, devices):
"this light is the chandelier in living room"
Return: {"learn":{"type":"room_device","category":"lights","sub_category":"chandelier","entity_id":"light.rgbw_1","value":"living room"},"chat":"Got it boss, saved as chandelier in living room."}
AC ENTITY LEARNING W/ MODES (18, 20, on, off):
"this is home theater ac 18 degree"
Return: {"learn":{"type":"room_ac","sub_category":"main ac","mode":"18","entity_id":"switch.ac_18","value":"home theater"},"chat":"Saved 18 degree mode for home theater AC."}
MEMORY USAGE & SENSORS
Memory includes room_aliases, lights, ac, covers, sensors, devices (with subcategories):
${JSON.stringify(mem || {})}
* If user queries sensor details (e.g. "temperature here"), lookup the room's sensor entity in memory. Then find its state from the ENTITIES context below and reply naturally!
* If user acts on a subcategory (e.g. "turn on chandelier"), trigger ALL entities listed under that subcategory.
SERVICES & ENTITY DOMAINS (CRITICAL RULES):
* ALWAYS match the domain/service to the ENTITY PREFIX.
* If entity is switch. (e.g., switch.curtain_main) ALWAYS use switch / turn_on or turn_off. NEVER use open_cover.
* If entity is cover. use cover / open_cover or close_cover.
light turn_on(brightness_pct 0-100, color_temp_kelvin 2000-6500 ONLY, rgb_color[r,g,b])/turn_off/toggle
switch/fan/input_boolean turn_on/turn_off/toggle (Use this for curtains IF entity starts with switch.)
cover open_cover/close_cover/set_cover_position(position 0-100) (Use this for curtains IF entity starts with cover.)
media_player media_play/media_pause/volume_set(volume_level 0-1)/play_media(media_content_type="music", media_content_id="search query")
climate set_temperature(temperature)/set_hvac_mode (If exact AC degree switch not in memory)
scene/script turn_on
RESPONSE FORMAT (STRICT JSON ONLY)
Chat: {"chat":"Boss, which room are you in?"}
Light Command: {"domain":"light","service":"turn_on","data":{"entity_id":"light.rgbw_1","brightness_pct":30},"chat":"Done boss, brightness reduced."}
AC OFF (If entity starts with climate.): {"domain":"climate","service":"set_hvac_mode","data":{"entity_id":"climate.air_conditioner","hvac_mode":"off"},"chat":"Done boss, AC turned off."}
AC ON (If entity starts with climate.): {"domain":"climate","service":"set_hvac_mode","data":{"entity_id":"climate.air_conditioner","hvac_mode":"cool"},"chat":"Done boss, AC turned on."}
AC SWITCH (If learned AC entity starts with switch. or light.): {"domain":"switch","service":"turn_on","data":{"entity_id":"switch.home_theater_ac_off"},"chat":"Done boss, triggered the AC switch."}
PLAY MEDIA (When asked to play a song or movie on a speaker): {"domain":"media_player","service":"play_media","data":{"entity_id":"media_player.speaker_entity","media_content_type":"music","media_content_id":"<song name> from <movie name>"},"chat":"Playing it right away boss!"}
MULTIPLE ITEMS (Including Actions & Learning):
If you need to return multiple commands OR multiple learned variables in the same response, ALWAYS wrap them inside a single JSON array:
[{"learn":{"type":"room_alias","alias":"showroom","target":"mohan room"}},{"learn":{"type":"room_device","category":"lights","sub_category":"center light","entity_id":"switch.center_light","value":"showroom"},"chat":"Saved both center light and room alias!"}]
LEARNING (CRITICAL YOU MUST INCLUDE THE 'learn' OBJECT IF USER TEACHES YOU SOMETHING):
{"learn":{"type":"room_alias | room_device | room_ac","category":"lights | covers | sensors | devices (IF room_device)","sub_category":"chandelier | main blind | etc.","entity_id":"...","value":"...","alias":"...","target":"..."},"chat":"Saved boss."}
STRICT RULES
ALWAYS return JSON ONLY. NO raw text before or after.
Do NOT prepend your JSON with labels like "MULTIPLE:" or "AC ON:". Just output the raw '{' or '['.
NEVER auto execute indirect intent
ALWAYS confirm first (UNLESS it is a scheduled action with a time delay, then execute immediately)
ALWAYS ask room if missing
ALWAYS remember learned data
ALWAYS behave like assistant
Do NOT ask confirmation questions if the user specifies a time delay or schedule (e.g. "at 3:30 PM"). Output the JSON action directly!
ENTITIES:
${entsStr}${energyStatsStr}`;
}

async function parseNL(txt, entsStr, sid) {
  if (!IS_LICENSED) {
    return { chat: `Boss, my license check failed: ${LICENSE_MSG}. Please fix my configuration.` };
  }

  const energyStats = getEnergyContext();
  const msgs = [
    { role: 'system', content: buildPrompt(entsStr, energyStats) }
  ];
  const hist = readJson(CHATHISTORY_FILE);
  if (hist[sid] && hist[sid].messages) {
      hist[sid].messages.slice(-10).forEach(m => {
          if (!m.isHtml && m.role && m.content) msgs.push({ role: m.role, content: m.content });
      });
  }
  msgs.push({ role: 'user', content: txt });

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OAI_KEY}` },
    body: JSON.stringify({
      model: OAI_MODEL,
      temperature: 0.1,
      max_tokens: 400,
      messages: msgs
    })
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  
  const raw = data.choices[0].message.content.trim();
  console.log("GPT RAW RESP:", raw);
  let jsonStr = raw;
  let parsed;
  const match = raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  
  if (match) {
    jsonStr = match[0];
    if (jsonStr.match(/^\s*\{[\s\S]*\}\s*\{[\s\S]*\}\s*$/)) {
        jsonStr = `[${jsonStr.replace(/\}\s*\{/g, '},{')}]`;
    }
    try {
        parsed = JSON.parse(jsonStr);
    } catch (e) {
        parsed = { chat: raw };
    }
  } else {
    parsed = { chat: raw };
  }
  
  return parsed;
}

// --- COMMAND EXECUTION ---
async function executeCmds(cmds, reqEntities) {
  let results = [];
  cmds = Array.isArray(cmds) ? cmds : [cmds];
  
  let normalizedCmds = [];
  for (const c of cmds) {
    if (c.data && Array.isArray(c.data.entity_id)) {
      for (const id of c.data.entity_id) {
        normalizedCmds.push({ ...c, data: { ...c.data, entity_id: id } });
      }
    } else if (c.data && typeof c.data.entity_id === 'string' && c.data.entity_id.includes(',')) {
      const ids = c.data.entity_id.split(',').map(s => s.trim());
      for (const id of ids) {
         normalizedCmds.push({ ...c, data: { ...c.data, entity_id: id } });
      }
    } else {
      normalizedCmds.push(c);
    }
  }
  cmds = normalizedCmds;

  for (const c of cmds) {
    if (c.error) { results.push({ err: c.error }); continue; }
    
    if (c.learn) {
      let m = readJson(MEMORY_FILE);
      
      if (c.learn.type === 'room_alias') {
         if (!m.room_aliases) m.room_aliases = {};
         m.room_aliases[c.learn.alias] = c.learn.target;
      }
      
      let rv = c.learn.value;
      if (rv) {
         if (!m.rooms) m.rooms = {};
         if (!m.rooms[rv]) m.rooms[rv] = {};
         
         if (!m.rooms[rv].lights) m.rooms[rv].lights = {};
         if (!m.rooms[rv].covers) m.rooms[rv].covers = {};
         if (!m.rooms[rv].sensors) m.rooms[rv].sensors = {};
         if (!m.rooms[rv].devices) m.rooms[rv].devices = {};
         if (!m.rooms[rv].ac) m.rooms[rv].ac = {};
         
         if (['room_device', 'room', 'light', 'cover', 'sensor'].includes(c.learn.type)) {
            let cat = c.learn.category || (c.learn.entity_id?.startsWith('light') ? 'lights' : c.learn.entity_id?.startsWith('cover') ? 'covers' : c.learn.entity_id?.startsWith('sensor') ? 'sensors' : 'devices');
            let sub = c.learn.sub_category || 'default';
            
            if (Array.isArray(m.rooms[rv][cat])) {
               m.rooms[rv][cat] = { default: m.rooms[rv][cat] };
            }
            if (!m.rooms[rv][cat][sub]) m.rooms[rv][cat][sub] = [];
            if (!m.rooms[rv][cat][sub].includes(c.learn.entity_id)) m.rooms[rv][cat][sub].push(c.learn.entity_id);
         } else if (c.learn.type === 'room_ac' || c.learn.type === 'ac') {
            let sub = c.learn.sub_category || 'default';
            if (m.rooms[rv].ac.on || m.rooms[rv].ac.off) {
                let tempAc = { ...m.rooms[rv].ac };
                m.rooms[rv].ac = { default: tempAc };
            }
            if (!m.rooms[rv].ac[sub]) m.rooms[rv].ac[sub] = {};
            m.rooms[rv].ac[sub][c.learn.mode || 'on'] = c.learn.entity_id;
         }
      }
      writeJson(MEMORY_FILE, m);
      if (!c.domain) { continue; }
    }
    
    if (c.chat && !c.domain && !c.learn) { results.push({ chat: c.chat }); continue; }
    
    const eid = c.data?.entity_id;
    const ent = reqEntities.find(e => e.entity_id === eid);
    const name = ent ? ent.name : eid;
    
    try {
      const entityPrefix = eid?.split('.')[0] || c.domain;
      
      let actualDomain = c.domain;
      let actualService = c.service;
      let actualData = { ...c.data };
      
      if (entityPrefix && entityPrefix !== c.domain) {
        console.log(`Domain mismatch: command says ${c.domain} but entity is ${entityPrefix}. Using ${entityPrefix}.`);
        actualDomain = entityPrefix;
        
        if (entityPrefix === 'switch' || entityPrefix === 'input_boolean' || entityPrefix === 'light') {
          if (c.service.includes('open') || c.service === 'set_cover_position') {
            actualService = 'turn_on';
          } else if (c.service.includes('close')) {
            actualService = 'turn_off';
          }
          delete actualData.position;
        } else if (entityPrefix === 'cover') {
          if (c.service === 'turn_on') {
            actualService = 'open_cover';
          } else if (c.service === 'turn_off') {
            actualService = 'close_cover';
          }
        }
      }
      
      if (actualDomain === 'cover') {
        if (actualService === 'open_cover') {
          actualService = 'set_cover_position';
          actualData.position = 100;
        } else if (actualService === 'close_cover') {
          actualService = 'set_cover_position';
          actualData.position = 0;
        }
      }
      
      await callSvc(actualDomain, actualService, actualData);
      
      let actionStr = 'ON';
      if (actualService.includes('off') || actualService.includes('close')) actionStr = 'OFF';
      if (actualData.position === 0) actionStr = 'OFF';
      if (actualData.position === 100) actionStr = 'ON';
      
      logAction(name, actionStr, c);
      results.push({ name, err: null });
    } catch (e) {
      console.error(`Failed to execute command for ${eid}:`, e.message);
      results.push({ name, err: e.message });
    }
  }
  return results;
}

// --- SCHEDULER ENGINE ---
function scheduleExecution(delayMs, cmds, reqEntities, niceTime) {
  const s = readJson(SCHEDULE_FILE);
  const id = Date.now().toString();
  const executeAt = new Date(Date.now() + delayMs).toISOString();
  
  s.push({ id, cmds, reqEntities, executeAt, displayTime: niceTime });
  writeJson(SCHEDULE_FILE, s);
  
  startTimerForSchedule(id, delayMs, cmds, reqEntities);
}

function startTimerForSchedule(id, delayMs, cmds, reqEntities) {
  const d = Math.max(0, delayMs);
  SC_TIMERS[id] = setTimeout(async () => {
    try { await executeCmds(cmds, reqEntities); } catch (e) { console.error('Schedule Execution Error:', e); }
    let s = readJson(SCHEDULE_FILE);
    s = s.filter(x => x.id !== id);
    writeJson(SCHEDULE_FILE, s);
    delete SC_TIMERS[id];
  }, d);
}

function loadSchedules() {
  const s = readJson(SCHEDULE_FILE);
  const now = Date.now();
  s.forEach(sch => {
    const delay = new Date(sch.executeAt).getTime() - now;
    startTimerForSchedule(sch.id, delay, sch.cmds, sch.reqEntities);
  });
}
loadSchedules();

// --- HTTP SERVER ---
const server = http.createServer(async (req, res) => {
  console.log(`[REQUEST] ${req.method} ${req.url}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.url === '/favicon.ico') { res.writeHead(204); return res.end(); }

  // Admin HTML UI
  if (req.method === 'GET' && req.url === '/admin.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    try {
        res.end(fs.readFileSync(path.join(DIR, 'admin.html')));
    } catch(e) {
        res.end("Admin UI not found.");
    }
    return;
  }

  // --- DIRECT AUDIO UPLOAD ENDPOINT (Accepts WAV from Recorder.js) ---
  if (req.method === 'POST' && req.url === '/api/upload-audio') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const buffer = Buffer.concat(chunks);
        
        console.log(`Received audio upload, size: ${buffer.length} bytes`);
        
        // Recorder.js sends direct WAV data (already correct format)
        const wavBuffer = buffer;
        
        // Convert to MP3
        console.log('Converting WAV to MP3...');
        const mp3Buffer = await convertWavToMp3(wavBuffer);
        
        // Save locally
        const localMp3Path = path.join(LOCAL_AUDIO_PATH, 'Lumiai.mp3');
        fs.writeFileSync(localMp3Path, mp3Buffer);
        console.log('✅ MP3 saved locally:', localMp3Path);
        
        // Upload to FTP
        try {
          await uploadToFTP(mp3Buffer, 'Lumiai.mp3');
          console.log('✅ Audio uploaded to FTP');
        } catch (ftpErr) {
          console.warn('FTP upload failed, but local file saved:', ftpErr.message);
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Audio uploaded and converted' }));
      } catch (e) {
        console.error('Upload error:', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // --- CHECK MP3 ENDPOINT ---
  if (req.method === 'GET' && req.url === '/api/check-mp3') {
    const mp3Path = path.join(LOCAL_AUDIO_PATH, 'Lumiai.mp3');
    try {
      const stats = fs.statSync(mp3Path);
      const now = Date.now();
      const fileAge = now - stats.mtimeMs;
      
      if (fileAge < 30000) { // 30 seconds
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ready: true, age: fileAge }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ready: false, age: fileAge }));
      }
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready: false, error: 'File not found' }));
    }
    return;
  }

  // --- TRANSCRIBE MP3 ENDPOINT ---
  if (req.method === 'POST' && req.url === '/api/transcribe-mp3') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { mp3Path } = JSON.parse(body);
        const mp3FullPath = path.join(LOCAL_AUDIO_PATH, mp3Path);
        
        if (!fs.existsSync(mp3FullPath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'MP3 file not found' }));
        }
        
        const mp3Buffer = fs.readFileSync(mp3FullPath);
        const mp3Base64 = mp3Buffer.toString('base64');
        
        // Send to OpenAI Whisper
        const boundary = '----Boundary' + Math.random().toString(36).substring(2);
        const pre = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.mp3"\r\nContent-Type: audio/mp3\r\n\r\n`;
        const post = `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${boundary}--`;
        
        const payload = Buffer.concat([
          Buffer.from(pre, 'utf8'),
          Buffer.from(mp3Base64, 'base64'),
          Buffer.from(post, 'utf8')
        ]);
        
        const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Authorization': `Bearer ${OAI_KEY}`
          },
          body: payload
        });
        
        const ans = await whisperRes.json();
        if (ans.error) throw new Error(ans.error.message);
        
        console.log('Transcription result:', ans.text);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: ans.text || "" }));
      } catch (e) {
        console.error('Transcription error:', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // --- HA SERVICE PROXY ---
  if (req.method === 'POST' && req.url === '/api/ha-service') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { domain, service, data } = JSON.parse(body);
        const result = await callSvc(domain, service, data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/save-config') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify(payload, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(500); res.end(e.message); }
    });
    return;
  }

  // --- SMS PROXY ENDPOINT ---
  if (req.method === 'POST' && req.url === '/api/send-otp') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        let { phoneNumber, otp } = JSON.parse(body);
        phoneNumber = String(phoneNumber || '').trim();
        otp = String(otp || '').trim();
        
        if (!phoneNumber || !otp || !/^[0-9]{10}$/.test(phoneNumber) || !/^[0-9]{6}$/.test(otp)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Invalid format' }));
        }

        const msg = `Your OTP for login is ${otp}. It is valid for 5 minutes. Do not share this code with anyone. Contact support if the OTP was not requested by you - Ziamore.`;
        const smsUrl = `https://sms.textspeed.in/vb/apikey.php?apikey=gdCD8AQiQWAPDTS2&senderid=ZIAMRE&templateid=1707177390087516591&number=${phoneNumber}&message=${encodeURIComponent(msg)}`;
        
        https.get(smsUrl, (smsRes) => {
          let data = '';
          smsRes.on('data', chunk => data += chunk);
          smsRes.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'OTP dispatched' }));
          });
        }).on('error', (e) => {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'SMS proxy failed: ' + e.message }));
        });
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // --- SESSION HISTORY ENDPOINT ---
  if (req.method === 'GET' && req.url === '/api/sessions') {
    const s = readJson(CHATHISTORY_FILE);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(s));
  }
  if (req.method === 'DELETE' && req.url.startsWith('/api/sessions')) {
    const id = req.url.split('id=')[1];
    let s = readJson(CHATHISTORY_FILE);
    if (id && s[id]) delete s[id];
    writeJson(CHATHISTORY_FILE, s);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ok:true}));
  }

  // --- STATES ENDPOINT ---
  if (req.method === 'GET' && req.url === '/api/states') {
    try {
      const r = await fetch(`${HA_URL}/states`, {
        headers: { 'Authorization': `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' }
      });
      if (!r.ok) {
        const errText = await r.text();
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: `HA Error ${r.status}: ${errText}` }));
      }
      const data = await r.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ result: data }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (req.method === 'GET' && req.url === '/api/schedule') {
    const s = readJson(SCHEDULE_FILE);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(s));
  }

  if (req.method === 'DELETE' && req.url.startsWith('/api/schedule')) {
    const id = req.url.split('id=')[1];
    let s = readJson(SCHEDULE_FILE);
    if (id) {
      if (SC_TIMERS[id]) { clearTimeout(SC_TIMERS[id]); delete SC_TIMERS[id]; }
      s = s.filter(x => x.id !== id);
    } else {
      s.forEach(x => { if(SC_TIMERS[x.id]) { clearTimeout(SC_TIMERS[x.id]); delete SC_TIMERS[x.id]; } });
      s = [];
    }
    writeJson(SCHEDULE_FILE, s);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ok:true}));
  }
  
  if (req.method === 'GET' && req.url === '/api/history') {
    const h = readJson(HISTORY_FILE);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(h));
  }

  if (req.method === 'POST' && req.url === '/api/chat') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { text, entities, sessionId } = JSON.parse(body);
        let q = (text || '').toLowerCase().trim();
        const entsStr = (entities || []).map(e => `${e.name}|${e.entity_id}|${e.state}`).join('\n') || '(none)';
        const sid = sessionId || Date.now().toString();

        const endChat = (data) => {
            let s = readJson(CHATHISTORY_FILE);
            if (!s[sid]) s[sid] = { id: sid, title: (text||'').substring(0, 30) || 'New Chat', messages: [], updatedAt: Date.now() };
            s[sid].messages.push({ role: 'user', content: text||'' });
            s[sid].messages.push({ role: 'assistant', content: data.chat, isHtml: data.isHtml || false });
            s[sid].updatedAt = Date.now();
            writeJson(CHATHISTORY_FILE, s);
            data.sessionId = sid;
            return replyJSON(res, data);
        };

        // Follow-up "YES"
        if (q === 'yes' || q === 'yeah' || q === 'yep') {
            if (PENDING_REPEAT) {
              const r = await executeCmds(PENDING_REPEAT.cmds, entities);
              PENDING_REPEAT = null;
              let outputs = [];
              for (let i = 0; i < r.length; i++) {
                if (r[i].err) outputs.push(`${r[i].name} failed: ${r[i].err}`);
                else outputs.push(`${getIstTimeStr()} | ${r[i].name.toLowerCase()} | ON`);
              }
        
              return endChat({ chat: outputs.join('\n') });
            }
        } else {
            PENDING_REPEAT = null;
        }

        // LOGS & HISTORY & MEMORY
        if (q.includes('clear') && q.includes('memory')) {
            writeJson(MEMORY_FILE, { rooms: {} });
            let s = readJson(CHATHISTORY_FILE);
            if(s[sid]) s[sid].messages = [];
            writeJson(CHATHISTORY_FILE, s);
            return endChat({ chat: "Done! I have wiped my memory file and conversation context." });
        }
        
        if ((q.includes('history') || q.includes('log')) && (q.includes('delete') || q.includes('remove') || q.includes('clear')) && q.includes('all')) {
            writeJson(HISTORY_FILE, []);
            let s = readJson(CHATHISTORY_FILE);
            if(s[sid]) s[sid].messages = [];
            writeJson(CHATHISTORY_FILE, s);
            return endChat({ chat: "Done boss! I have cleared your entire action history." });
        }

        const logMatch = q.match(/last\s*(\d+)?\s*log/);
        if (logMatch || q.includes('last logs') || q.includes('show logs') || q === 'logs' || q === 'logs.') {
          const count = parseInt(logMatch?.[1] || 10);
          const h = readJson(HISTORY_FILE);
          const l = h.slice(-count);
          if (l.length === 0) return endChat({chat: "No logs found boss."});
          
          let logHtml = `<div style="display:flex;flex-direction:column;gap:6px;width:100%;margin-top:4px">`;
          l.forEach(x => {
            const time = getIstTimeStr(new Date(x.timestamp));
            const color = x.action === 'ON' ? 'var(--green)' : (x.action === 'OFF' ? 'var(--red)' : 'var(--accent)');
            logHtml += `<div style="background:var(--surf2);padding:8px 14px;border-radius:10px;font-size:13px;display:flex;justify-content:space-between;align-items:center;border:1px solid var(--bdr2);box-shadow:0 2px 8px rgba(0,0,0,0.2);">
              <span style="display:flex;align-items:center;"><span style="color:var(--txt3);font-size:11.5px;margin-right:12px;font-family:monospace">${time}</span><span style="font-weight:500;color:var(--txt)">${x.device}</span></span>
              <span style="color:${color};font-weight:600;font-size:11px;letter-spacing:0.5px;background:rgba(255,255,255,0.04);padding:2px 8px;border-radius:100px">${x.action}</span>
            </div>`;
          });
          logHtml += `</div>`;
          return endChat({chat: logHtml, isHtml: true});
        }

        // REPEAT LAST ACTION
        if (q === 'repeat last action' || q === 'repeat last') {
          const h = readJson(HISTORY_FILE);
          for (let i = h.length - 1; i >= 0; i--) {
            if (h[i].rawCmd) {
              const c = h[i].rawCmd;
              const r = await executeCmds([c], entities);
              const name = (r[0] && !r[0].err) ? r[0].name : "the device";
              let actionStr = 'turned ON';
              if (c.service && (c.service.includes('off') || c.service.includes('close'))) actionStr = 'turned OFF';
              return endChat({ chat: `I have ${actionStr} ${name.toLowerCase()} boss!` });
            }
          }
          return endChat({ chat: "No previous action to repeat boss." });
        }

        // SCHEDULES MANAGEMENT
        if (q.includes('schedule') || q.includes('schedules')) {
          if (q.match(/\b(show|what|list)\b/)) {
            const sum = readJson(SCHEDULE_FILE).length;
            if (sum === 0) return endChat({ chat: "No schedules found boss." });
            return endChat({ chat: `You have ${sum} scheduled actions boss. Check the schedule icon at the top for details!` });
          }
          if (q.includes('remove') || q.includes('delete') || q.includes('cancel') || q.includes('clear')) {
            let s = readJson(SCHEDULE_FILE);
            if (q.includes('all')) {
              s.forEach(x => { if(SC_TIMERS[x.id]) { clearTimeout(SC_TIMERS[x.id]); delete SC_TIMERS[x.id]; } });
              writeJson(SCHEDULE_FILE, []);
              return endChat({ chat: "Done boss! I have removed all schedules." });
            }
          }
        }

        // TIME LOOKBACK
        const isEnergyQuery = q.includes('power') || q.includes('energy') || q.includes('consumption') || q.includes('cost') || q.includes('bill') || q.includes('kwh');
        if (!isEnergyQuery && (q.includes('yesterday') || q.includes('ago') || q.includes('before') || q.match(/(\d+)\s*mis\s*befor/))) {
          let target = Date.now();
          let windowMs = 15 * 60 * 1000;
          if (q.includes('yesterday')) target -= 24 * 3600 * 1000;
          
          const h = readJson(HISTORY_FILE);
          let found = h.filter(x => Math.abs(new Date(x.timestamp).getTime() - target) <= windowMs);
          
          
          if (!found.length) return endChat({ chat: "No actions found around that time boss."});
          
          PENDING_REPEAT = { cmds: found.map(x => x.rawCmd).filter(x => !!x) };
          
          let logHtml = `<div style="display:flex;flex-direction:column;gap:6px;width:100%;margin-top:4px">`;
          found.forEach(x => {
            const time = getIstTimeStr(new Date(x.timestamp));
            const color = x.action === 'ON' ? 'var(--green)' : (x.action === 'OFF' ? 'var(--red)' : 'var(--accent)');
            logHtml += `<div style="background:var(--surf2);padding:8px 14px;border-radius:10px;font-size:13px;display:flex;justify-content:space-between;align-items:center;border:1px solid var(--bdr2);box-shadow:0 2px 8px rgba(0,0,0,0.2);">
              <span style="display:flex;align-items:center;"><span style="color:var(--txt3);font-size:11.5px;margin-right:12px;font-family:monospace">${time}</span><span style="font-weight:500;color:var(--txt)">${x.device}</span></span>
              <span style="color:${color};font-weight:600;font-size:11px;letter-spacing:0.5px;background:rgba(255,255,255,0.04);padding:2px 8px;border-radius:100px">${x.action}</span>
            </div>`;
          });
          logHtml += `</div><div style="margin-top:10px;font-size:13.5px">Do you want me to repeat this?</div>`;
          return endChat({chat: logHtml, isHtml: true});
        }

        // DELAYS & SCHEDULES
        let delayMs = 0;
        let niceTime = '';
        const delayMatch = q.match(/after (\d+) (second|minute|hour)s?/);
        const atMatch = q.match(/at (\d+)(?::(\d+))?\s*(pm|am)?/);
        
        let cleanedQ = q;
        if (delayMatch) {
          const v = parseInt(delayMatch[1]), u = delayMatch[2];
          if (u === 'second') delayMs = v * 1000;
          if (u === 'minute') delayMs = v * 60 * 1000;
          if (u === 'hour') delayMs = v * 3600 * 1000;
          cleanedQ = cleanedQ.replace(delayMatch[0], '').trim();
          niceTime = `in ${v} ${u}s`;
        } else if (atMatch) {
          let hr = parseInt(atMatch[1]);
          let mn = parseInt(atMatch[2] || 0);
          let ampm = atMatch[3];
          if (ampm === 'pm' && hr < 12) hr += 12;
          if (ampm === 'am' && hr === 12) hr = 0;
          
          let now = new Date();
          const istStr = new Intl.DateTimeFormat('en-US', {timeZone:'Asia/Kolkata', year:'numeric', month:'numeric', day:'numeric'}).format(now);
          const tDate = new Date(`${istStr} ${hr}:${mn}:00 GMT+0530`);
          if (tDate.getTime() < Date.now()) tDate.setDate(tDate.getDate() + 1);
          delayMs = tDate.getTime() - Date.now();
          cleanedQ = cleanedQ.replace(atMatch[0], '').trim();
          niceTime = `at ${hr}:${mn.toString().padStart(2, '0')} ${ampm||''}`.trim();
        }

        // OPENAI NLP
        const aiQuery = delayMs > 0 ? `${cleanedQ} (CRITICAL: User is scheduling this. DO NOT ask for confirmation, output the action JSON immediately.)` : (cleanedQ || "turn on");
        const parsed = await parseNL(aiQuery, entsStr, sid);
        if (parsed.chat && !parsed.domain && !parsed.learn) return endChat({ chat: parsed.chat });
        
        const cmds = Array.isArray(parsed) ? parsed : [parsed];

        if (delayMs > 0) {
          scheduleExecution(delayMs, cmds, entities, niceTime);
          return replyJSON(res, { chat: `Got it boss, I've scheduled that for ${niceTime}.` });
        } else {
          const results = await executeCmds(cmds, entities);
          let outputs = [];
          for (let i = 0; i < results.length; i++) {
              if (results[i].err) outputs.push(`${results[i].name} failed: ${results[i].err}`);
          }
          if (outputs.length > 0) return replyJSON(res, { chat: outputs.join('\n') });
          
          return replyJSON(res, { chat: Array.isArray(parsed) ? (parsed[0]?.chat || "Consider it done boss!") : (parsed.chat || "Done boss!") });
        }
      } catch (e) {
        return replyJSON(res, { chat: `Ran into an issue boss: ${e.message}` });
      }
    });
    return;
  }

  // Serving static files
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  
  const fp = path.join(DIR, urlPath);
  try {
    const data = fs.readFileSync(fp);
    const ext  = path.extname(fp);
    const ct   = MIME[ext] || 'text/plain';
    res.writeHead(200, { 
      'Content-Type': ct, 
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Surrogate-Control': 'no-store'
    });
    res.end(data);
  } catch (err) { 
    console.error(`[Static File Error] Failed to serve ${fp}:`, err.message);
    res.writeHead(404); 
    res.end('404 Not Found - ' + urlPath); 
  }
});

function replyJSON(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Lumi Demo AI Backend running at http://localhost:${PORT}`);
  console.log(`Audio endpoints ready (using Recorder.js compatible WAV format):`);
  console.log(`  - POST /api/upload-audio (Direct WAV upload)`);
  console.log(`  - GET  /api/check-mp3 (Check if MP3 is ready)`);
  console.log(`  - POST /api/transcribe-mp3 (Transcribe MP3 via Whisper)`);
});