const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const alarmFile = path.join(__dirname, 'alarm.mp3');
const stopFlagFile = path.join(__dirname, 'stop.flag');
const heartbeatFile = path.join(__dirname, 'heartbeat.txt');
let alarmProcess = null;
let dailyAlarmsEnabledToday = true;
let alarmVolume = 100;
let lastResetDate = new Date().toDateString();
const pendingTimeouts = new Map(); // Track setTimeout IDs for cleanup
let config = { volume: 100 }; // Config to persist volume

const DAILY_SCHEDULE = [
  { hour: 7, minute: 0 },
  { hour: 9, minute: 0 },
  { hour: 10, minute: 0 },
  { hour: 11, minute: 0 },
  { hour: 11, minute: 15 },
  { hour: 12, minute: 30 },
  { hour: 13, minute: 15 },
  { hour: 14, minute: 30 },
  { hour: 14, minute: 45 },
  { hour: 16, minute: 0 },
  { hour: 16, minute: 30 },
  { hour: 18, minute: 0 },
  { hour: 18, minute: 15 },
  { hour: 19, minute: 30 },
  { hour: 19, minute: 45 },
  { hour: 21, minute: 0 }
];

function log(msg) {
  const now = new Date();
  const stamp = now.toISOString().replace('T', ' ').split('.')[0];
  console.log(`[${stamp}] ${msg}`);
}

function stopAlarm() {
  if (!alarmProcess) {
    log('No alarm is currently playing.');
    return false;
  }
  try {
    alarmProcess.kill();
    alarmProcess = null;
    log('Alarm stopped.');
    return true;
  } catch (err) {
    log(`Error stopping alarm: ${err.message}`);
    return false;
  }
}

function playAlarm(label) {
  if (!fs.existsSync(alarmFile)) {
    log('alarm.mp3 not found in this folder. Add the file and try again.');
    return;
  }

  if (alarmProcess) {
    log('Alarm already playing.');
    return;
  }

  const escapedPath = alarmFile.replace(/'/g, "''");
  const volScalar = Math.max(0.01, Math.min(1, alarmVolume / 100)); // clamp to 1%-100%
  const psScript = [
    "# Set system volume and create media player",
    "Add-Type -TypeDefinition @'",
    "using System.Runtime.InteropServices;",
    "[Guid(\"5CDF2C82-841E-4546-9722-0CF74078229A\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]",
    "interface IAudioEndpointVolume {",
    "  int _0(); int _1(); int _2(); int _3();",
    "  int SetMasterVolumeLevelScalar(float fLevel, System.Guid pguidEventContext);",
    "  int _5();",
    "  int GetMasterVolumeLevelScalar(out float pfLevel);",
    "  int _7(); int _8(); int _9(); int _10(); int _11(); int _12();",
    "}",
    "[Guid(\"D666063F-1587-4E43-81F1-B948E807363F\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]",
    "interface IMMDevice {",
    "  int Activate(ref System.Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev);",
    "}",
    "[Guid(\"A95664D2-9614-4F35-A746-DE8DB63617E6\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]",
    "interface IMMDeviceEnumerator {",
    "  int _0();",
    "  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);",
    "}",
    "[ComImport, Guid(\"BCDE0395-E52F-467C-8E3D-C4579291692E\")]",
    "class MMDeviceEnumeratorComObject { }",
    "public class Audio {",
    "  static IAudioEndpointVolume GetVol() {",
    "    var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;",
    "    IMMDevice dev = null;",
    "    Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 0, out dev));",
    "    IAudioEndpointVolume epv = null;",
    "    var epvid = typeof(IAudioEndpointVolume).GUID;",
    "    Marshal.ThrowExceptionForHR(dev.Activate(ref epvid, 1, 0, out epv));",
    "    return epv;",
    "  }",
    "  public static void SetVol(float v) { GetVol().SetMasterVolumeLevelScalar(v, System.Guid.Empty); }",
    "}",
    "'@",
    `[Audio]::SetVol(${volScalar})`,
    "",
    "# Load required assemblies for audio playback",
    "Add-Type -AssemblyName presentationCore",
    "",
    "# Create media player",
    "$mediaPlayer = New-Object System.Windows.Media.MediaPlayer",
    `$mediaPlayer.Open([System.Uri]::new('${escapedPath}'))`,
    `$mediaPlayer.Volume = ${volScalar}`,
    "",
    "# Play in loop",
    "while ($true) {",
    "  $mediaPlayer.Play()",
    "  Start-Sleep -Milliseconds 500",
    "  # Check if we need to restart",
    "  if ($mediaPlayer.Position -ge $mediaPlayer.NaturalDuration.TimeSpan) {",
    "    $mediaPlayer.Position = [TimeSpan]::Zero",
    "    $mediaPlayer.Play()",
    "  }",
    "}"
  ].join('\n');

  alarmProcess = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript], {
    stdio: 'ignore',
    detached: false
  });

  alarmProcess.on('exit', () => {
    alarmProcess = null;
  });

  alarmProcess.on('error', (err) => {
    log(`Could not play alarm: ${err.message}`);
    alarmProcess = null;
  });

  log(`\u23f0 ALARM${label ? ` (${label})` : ''}! Type "stop the alarm" to stop it.`);
}

function msUntil(time) {
  return Math.max(0, time.getTime() - Date.now());
}

function nextOccurrence(hour, minute) {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  // If target is in the past, schedule for tomorrow
  if (target < now) {
    target.setDate(target.getDate() + 1);
  }
  return target;
}

function scheduleAt(timeStr, label, alarmId) {
  const match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    log('Time must be HH:MM in 24h format.');
    return;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    log('Time must be HH:MM in 24h format.');
    return;
  }

  const fireTime = nextOccurrence(hour, minute);
  const delay = msUntil(fireTime);
  const timeoutId = setTimeout(() => {
    playAlarm(label);
    removePending(alarmId);
    pendingTimeouts.delete(`alarm_${alarmId}`);
  }, delay);
  
  // Register timeout immediately using provided alarmId to avoid race condition
  if (alarmId) {
    pendingTimeouts.set(`alarm_${alarmId}`, timeoutId);
  }
  log(`Scheduled for ${fireTime.toLocaleString()}${label ? ` (${label})` : ''}.`);
}

function scheduleIn(minutes, label, alarmId) {
  const mins = Number(minutes);
  if (!Number.isFinite(mins) || mins <= 0 || mins > 1440) {
    log('Minutes must be a positive number between 0.001 and 1440.');
    return;
  }
  
  // Allow fractional minutes (e.g., 0.001 = 60ms); ensure at least 1ms delay
  const delayMs = Math.max(1, Math.round(mins * 60 * 1000));
  const fireTime = new Date(Date.now() + delayMs);
  
  const timeoutId = setTimeout(() => {
    playAlarm(label);
    removePending(alarmId);
    pendingTimeouts.delete(`alarm_${alarmId}`);
  }, delayMs);
  
  // Register timeout immediately using provided alarmId to avoid race condition
  if (alarmId) {
    pendingTimeouts.set(`alarm_${alarmId}`, timeoutId);
  }
  log(`Scheduled in ${mins} minute(s) at ${fireTime.toLocaleString()}${label ? ` (${label})` : ''}.`);
}

let dailyResetScheduled = false;

function scheduleDailyReset() {
  if (dailyResetScheduled) return;
  dailyResetScheduled = true;
  
  function scheduleReset() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    const delay = msUntil(tomorrow);
    
    setTimeout(() => {
      const newDay = new Date().toDateString();
      if (newDay !== lastResetDate) {
        lastResetDate = newDay;
        dailyAlarmsEnabledToday = true;
        saveConfig(); // Persist the reset state
        log('Daily alarms reset for new day.');
      }
      scheduleReset(); // Reschedule reset for next day
    }, delay);
  }
  scheduleReset();
}

function scheduleDailyAlarm(hour, minute) {
  function scheduleNext() {
    const fireTime = nextOccurrence(hour, minute);
    const delay = msUntil(fireTime);
    const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    
    // Store timeout but allow it to be overwritten each day
    const timeoutId = setTimeout(() => {
      if (dailyAlarmsEnabledToday) {
        playAlarm(`Daily ${timeStr}`);
      }
      scheduleNext(); // Always reschedule, even if disabled
    }, delay);
    
    pendingTimeouts.set(`daily_${timeStr}`, timeoutId);
  }
  scheduleNext();
}

function initDailyAlarms() {
  DAILY_SCHEDULE.forEach(({ hour, minute }) => {
    scheduleDailyAlarm(hour, minute);
  });
  scheduleDailyReset(); // Schedule the daily reset for midnight
  log('Daily alarm schedule initialized (7AM, 9AM, 10AM, 11AM, 11:15AM, 12:30PM, 1:15PM, 2:30PM, 2:45PM, 4PM, 4:30PM, 6PM, 6:15PM, 7:30PM, 7:45PM, 9PM).');
}

let heartbeatTimer = null;
function startHeartbeat() {
  const writeBeat = () => {
    try {
      fs.writeFileSync(heartbeatFile, `${Date.now()}`);
    } catch (err) {
      log(`Warning: Could not write heartbeat: ${err.message}`);
    }
  };
  writeBeat();
  heartbeatTimer = setInterval(writeBeat, 3000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function printHelp() {
  console.log('Commands:');
  console.log("  in <minutes> [label]   - alarm after N minutes (decimals ok, max 1440)");
  console.log("  at <HH:MM> [label]     - alarm at 24h clock time (tomorrow if time passed)");
  console.log('  vol [0-100]            - show or set alarm volume (%)'); 
  console.log('  stop the alarm         - stop currently playing alarm');
  console.log('  disable daily          - turn off daily alarms for today (auto-reset at midnight)');
  console.log('  enable daily           - turn on daily alarms for today');
  console.log('  list                   - show pending timers');
  console.log('  clear pending          - clear all pending manual alarms');
  console.log('  status                 - show scheduler status');
  console.log('  help                   - show this help');
  console.log('  quit/exit              - stop scheduler');
}

const pending = [];
let alarmIdCounter = 0;

function nextAlarmId() {
  return ++alarmIdCounter;
}

function removePending(id) {
  const idx = pending.findIndex(p => p.id === id);
  if (idx !== -1) {
    pending.splice(idx, 1);
    savePending();
    return true;
  }
  return false;
}

function loadConfig() {
  try {
    if (fs.existsSync('config.json')) {
      const data = fs.readFileSync('config.json', 'utf8');
      config = JSON.parse(data);
      const loadedVol = config.volume ?? 100; // Use nullish coalescing to handle 0 correctly
      alarmVolume = Math.min(100, Math.max(1, Number(loadedVol) || 100));
      alarmIdCounter = config.alarmIdCounter ?? 0; // Restore counter to prevent ID collisions
      lastResetDate = config.lastResetDate ?? new Date().toDateString(); // Restore last reset date
      dailyAlarmsEnabledToday = config.dailyAlarmsEnabledToday ?? true; // Restore daily alarms state
      log(`Loaded config: volume=${alarmVolume}%, alarmIdCounter=${alarmIdCounter}.`);
    }
  } catch (err) {
    log(`Warning: Could not load config.json: ${err.message}`);
    config = { volume: 100, alarmIdCounter: 0 };
    alarmIdCounter = 0;
    lastResetDate = new Date().toDateString(); // Reset lastResetDate if config is corrupted
  }
}

function saveConfig() {
  try {
    config.volume = Math.min(100, Math.max(1, Math.round(alarmVolume)));
    config.alarmIdCounter = alarmIdCounter; // Persist counter
    config.lastResetDate = lastResetDate; // Persist last reset date
    config.dailyAlarmsEnabledToday = dailyAlarmsEnabledToday; // Persist daily alarms state
    fs.writeFileSync('config.json', JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    log(`Warning: Could not save config.json: ${err.message}`);
  }
}

function savePending() {
  try {
    // Backup before overwrite to prevent corruption
    if (fs.existsSync('pending.json')) {
      fs.copyFileSync('pending.json', 'pending.json.bak');
    }
    fs.writeFileSync('pending.json', JSON.stringify(pending, null, 2), 'utf8');
  } catch (err) {
    log(`Warning: Could not save pending.json: ${err.message}`);
    // Try to restore from backup if save failed
    try {
      if (fs.existsSync('pending.json.bak')) {
        fs.copyFileSync('pending.json.bak', 'pending.json');
      }
    } catch (e) {
      log(`Warning: Could not restore from backup: ${e.message}`);
    }
  }
}

function loadPending() {
  try {
    if (fs.existsSync('pending.json')) {
      const data = fs.readFileSync('pending.json', 'utf8');
      const loaded = JSON.parse(data);
      const now = Date.now();
      
      // Restore pending alarms and reschedule
      loaded.forEach(p => {
        if (p.type === 'in' && p.fireTime) {
          if (p.fireTime <= now) {
            // Fire missed 'in' alarms immediately
            playAlarm(`Missed: ${p.label || 'alarm'}`);
          } else {
            // Reschedule future 'in' alarms
            const delay = p.fireTime - now;
            const timeoutId = setTimeout(() => {
              playAlarm(`${p.label || 'alarm'}`);
              removePending(p.id);
              pendingTimeouts.delete(`alarm_${p.id}`);
            }, delay);
            pendingTimeouts.set(`alarm_${p.id}`, timeoutId);
            pending.push(p);
          }
        } else if (p.type === 'at' && p.when) {
          const [hour, minute] = p.when.split(':').map(Number);
          let fireTime = nextOccurrence(hour, minute);
          
          // Skip if time has passed (don't add to pending list)
          if (fireTime.getTime() <= now) {
            log(`Skipped past 'at' alarm: ${p.when}${p.label ? ` (${p.label})` : ''}.`);
          } else {
            const delay = msUntil(fireTime);
            // Skip if more than 24h away
            if (delay > 86400000) {
              log(`Skipped 'at' alarm more than 24h away: ${p.when}${p.label ? ` (${p.label})` : ''}.`);
            } else {
              const timeoutId = setTimeout(() => {
                playAlarm(`${p.label || 'alarm'}`);
                removePending(p.id);
                pendingTimeouts.delete(`alarm_${p.id}`);
              }, delay);
              pendingTimeouts.set(`alarm_${p.id}`, timeoutId);
              pending.push(p);
            }
          }
        }
      });
      
      // Track and update alarmIdCounter to prevent ID collisions
      let maxIdLoaded = alarmIdCounter;
      loaded.forEach(p => {
        if (p.id > maxIdLoaded) maxIdLoaded = p.id;
      });
      alarmIdCounter = maxIdLoaded;
      
      log(`Loaded ${pending.length} pending alarms from persistent storage.`);
      
      // Save state to remove any missed alarms from persistent storage
      savePending();
    }
  } catch (err) {
    log(`Warning: Could not load pending.json: ${err.message}`);
    // Try to restore from backup
    try {
      if (fs.existsSync('pending.json.bak')) {
        fs.copyFileSync('pending.json.bak', 'pending.json');
        log('Restored from backup.');
      }
    } catch (e) {
      log(`Warning: Could not restore from backup: ${e.message}`);
    }
  }
}

function addPending(type, when, label, fireTime = null) {
  // Prevent duplicate 'at' alarms, limit 'in' duplicates to 2
  if (type === 'at') {
    const exists = pending.some(p => p.type === type && p.when === when && (p.label || '') === (label || ''));
    if (exists) {
      log('This alarm is already scheduled.');
      return null;
    }
  } else if (type === 'in') {
    // Count identical 'in' alarms
    const count = pending.filter(p => p.type === type && p.when === when && (p.label || '') === (label || '')).length;
    if (count >= 2) {
      log(`Maximum 2 identical alarms allowed. You have ${count} already.`);
      return null;
    }
  }
  
  const entry = { id: nextAlarmId(), type, when, label };
  if (fireTime) {
    entry.fireTime = fireTime.getTime();
  }
  pending.push(entry);
  savePending();
  return entry; // Return the entry with ID to avoid race condition
}

function showPending() {
  const hasPending = pending.length > 0;
  const dailyStatus = dailyAlarmsEnabledToday ? 'ENABLED' : 'DISABLED';
  
  log(`Daily alarms: ${dailyStatus}`);
  if (dailyAlarmsEnabledToday) {
    log('Daily schedule: 7:00, 9:00, 10:00, 11:00, 11:15, 12:30, 13:15, 14:30, 14:45, 16:00, 16:30, 18:00, 18:15, 19:30, 19:45, 21:00');
  }
  
  if (!hasPending) {
    log('No manual alarms scheduled.');
    return;
  }
  
  log('Manual alarms:');
  const now = Date.now();
  let displayIdx = 1;
  pending.forEach((p) => {
    // Skip already-fired alarms but re-number visible ones
    let shouldShow = true;
    
    // For 'in' alarms, check fireTime directly
    if (p.type === 'in' && p.fireTime && p.fireTime <= now) {
      shouldShow = false;
    }
    // For 'at' alarms, recalculate fireTime to check if it's in the past
    else if (p.type === 'at' && p.when) {
      const match = p.when.match(/^(\d{1,2}):(\d{2})$/);
      if (match) {
        const hour = Number(match[1]);
        const minute = Number(match[2]);
        const fireTime = nextOccurrence(hour, minute);
        if (fireTime.getTime() <= now) {
          shouldShow = false;
        }
      }
    }
    
    if (shouldShow) {
      log(`  #${displayIdx}: ${p.type} ${p.when}${p.label ? ` (${p.label})` : ''}`);
      displayIdx++;
    }
  });
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const wasRestarted = process.env.SCHEDULER_RESTARTED === 'true';
if (wasRestarted) {
  log('App exited in an unexpected way and was restarted by the watchdog');
  delete process.env.SCHEDULER_RESTARTED;
}

log('Study Scheduler ready. Type "help" for commands.');
if (!fs.existsSync(alarmFile)) {
  log('Place alarm.mp3 in this folder so the alarm can play.');
}

loadConfig();
loadPending();

// Check if we're on a new day and reset daily alarms BEFORE initializing them
// This ensures dailyAlarmsEnabledToday is correct before scheduling
const today = new Date().toDateString();
if (today !== lastResetDate) {
  lastResetDate = today;
  dailyAlarmsEnabledToday = true;
  saveConfig(); // Persist the daily state
  log('New day detected. Daily alarms reset to ENABLED.');
}

// Clear any existing daily alarm timeouts before reinitializing
// This prevents duplicate daily alarms if the app restarts within the same day
const dailyKeys = Array.from(pendingTimeouts.keys()).filter(key => key.startsWith('daily_'));
dailyKeys.forEach(key => {
  const timeoutId = pendingTimeouts.get(key);
  clearTimeout(timeoutId);
  pendingTimeouts.delete(key);
});
dailyResetScheduled = false; // Reset flag so scheduleDailyReset can run again

initDailyAlarms();
startHeartbeat();

function handle(line) {
  const input = line.trim();
  if (!input) return;
  if (input.toLowerCase() === 'stop the alarm') {
    stopAlarm();
    return;
  }
  
  const [cmd, ...rest] = input.split(/\s+/);

  switch (cmd.toLowerCase()) {
    case 'in': {
      const [mins, ...labelParts] = rest;
      if (!mins) {
        log('Usage: in <minutes> [label]');
        break;
      }
      const minsNumber = Number(mins);
      if (!Number.isFinite(minsNumber) || minsNumber <= 0 || minsNumber > 1440) {
        log('Minutes must be a positive number between 0.001 and 1440.');
        break;
      }
      const label = labelParts.join(' ').trim();
      const fireTime = new Date(Date.now() + minsNumber * 60 * 1000);
      const entry = addPending('in', `${mins}m`, label, fireTime);
      if (entry) {
        scheduleIn(minsNumber, label, entry.id);
      }
      break;
    }
    case 'at': {
      const [time, ...labelParts] = rest;
      if (!time) {
        log('Usage: at <HH:MM> [label]');
        break;
      }
      const label = labelParts.join(' ').trim();
      // Parse time and calculate fireTime
      const match = time.match(/^(\d{1,2}):(\d{2})$/);
      if (match) {
        const hour = Number(match[1]);
        const minute = Number(match[2]);
        // Validate hour and minute ranges
        if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
          log('Time must be HH:MM in 24h format (00:00 to 23:59).');
          break;
        }
        const fireTime = nextOccurrence(hour, minute);
        const entry = addPending('at', time, label, fireTime);
        if (entry) {
          scheduleAt(time, label, entry.id);
        }
      } else {
        log('Time must be HH:MM in 24h format.');
      }
      break;
    }
    case 'disable':
    case 'enable': {
      if (!rest[0] || rest[0].toLowerCase() !== 'daily') {
        log(`Use "${cmd.toLowerCase()} daily" to turn ${cmd.toLowerCase()} daily alarms.`);
        break;
      }
      dailyAlarmsEnabledToday = cmd.toLowerCase() === 'enable';
      saveConfig(); // Persist the toggle state
      log(`Daily alarms ${dailyAlarmsEnabledToday ? 'ENABLED' : 'DISABLED'} for today.`);
      if (!dailyAlarmsEnabledToday) {
        log('They will resume tomorrow at midnight.');
      }
      break;
    }
    case 'list':
      showPending();
      break;
    case 'clear':
      if (rest[0] && rest[0].toLowerCase() === 'pending') {
        // Clear timeouts for all pending alarms atomically
        pending.forEach(p => {
          const timeoutId = pendingTimeouts.get(`alarm_${p.id}`);
          if (timeoutId) {
            clearTimeout(timeoutId);
            pendingTimeouts.delete(`alarm_${p.id}`);
          }
        });
        pending.length = 0;
        savePending();
        log('Pending alarms cleared.');
      } else {
        log('Use "clear pending" to clear all pending manual alarms.');
      }
      break;
    case 'status':
      log(`Scheduler status: Running`);
      log(`Current volume: ${alarmVolume}%`);
      log(`Daily alarms: ${dailyAlarmsEnabledToday ? 'ENABLED' : 'DISABLED'}`);
      log(`Next daily alarm check at midnight (automatic reset).`);
      break;
    case 'vol': {
      if (!rest[0]) {
        log(`Current alarm volume: ${alarmVolume}%`);
        break;
      }
      const vol = Number(rest[0]);
      if (!Number.isFinite(vol) || vol <= 0 || vol > 100) {
        log('Volume must be a number between 1 and 100.');
      } else {
        alarmVolume = vol;
        saveConfig();
        log(`Alarm volume set to ${vol}%.`);
      }
      break;
    }
    case 'h':
    case 'help':
      printHelp();
      break;
    case 'quit':
    case 'exit': {
      stopAlarm();
      // Create stop flag to signal watchdog this was intentional
      try {
        fs.writeFileSync(stopFlagFile, 'stop', 'utf8');
      } catch (e) {
        log(`Warning: Could not write stop flag: ${e.message}`);
      }
      stopHeartbeat();
      // Clear all pending timeouts atomically
      pendingTimeouts.forEach((timeoutId) => {
        clearTimeout(timeoutId);
      });
      pendingTimeouts.clear();
      pending.length = 0;
      log('Goodbye!');
      try {
        rl.close();
      } catch (e) {
        log(`Warning: Error closing interface: ${e.message}`);
      }
      return;
    }
    default:
      log('Unknown command. Type "help" for options.');
  }
}

rl.on('line', handle);
rl.on('close', () => process.exit(process.exitCode || 0));

process.on('uncaughtException', (err) => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
