const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const chalk = require('chalk');

// Initialize readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: ''
});

const alarmFile = path.join(__dirname, 'alarm.mp3');
const stopFlagFile = path.join(__dirname, 'stop.flag');
const heartbeatFile = path.join(__dirname, 'heartbeat.txt');

// Constants
const MAX_SETTIMEOUT_DELAY = 2147483647; // 32-bit signed integer max (~24.8 days)
const SEVEN_DAYS_MS = 604800000; // 7 days in milliseconds
const DUPLICATE_ALARM_WINDOW_MS = 1000; // Window to detect accidental duplicate alarms (increased from 500ms)
const HEARTBEAT_WARNING_INTERVAL_MS = 30000; // Throttle heartbeat warnings to once per 30s
const MAX_COUNTER_VALUE = 1000000000; // Reset counters at 1 billion to prevent overflow

let alarmProcess = null;
let dailyAlarmsEnabledToday = true;
let alarmVolume = 100;
let lastResetDate = new Date().toDateString();
const pendingTimeouts = new Map(); // Track setTimeout IDs for cleanup
let config = { volume: 100 }; // Config to persist volume

// Missed manual alarms (daily alarms are never considered missed)
const missedAlarms = [];

// Daily alarms are now stored dynamically
let dailyAlarms = [];
let dailyAlarmIdCounter = 0;

function nextDailyAlarmId() {
  // Protect against overflow (reset at 1 billion to stay safe)
  if (dailyAlarmIdCounter >= MAX_COUNTER_VALUE) {
    // Find minimum unused ID to prevent collisions with existing daily alarms
    const usedIds = new Set(dailyAlarms.map(d => d.id));
    let newId = 1;
    while (usedIds.has(newId) && newId < MAX_COUNTER_VALUE) {
      newId++;
    }
    // Validate we found a valid ID
    if (newId >= MAX_COUNTER_VALUE) {
      console.log(chalk.red(`Error: Cannot create daily alarm - all ${MAX_COUNTER_VALUE} IDs are in use.`));
      return null;
    }
    dailyAlarmIdCounter = newId - 1; // Will be incremented below
    console.log(chalk.yellow(`Daily counter overflow detected. Reset to ${newId}.`));
  }
  return ++dailyAlarmIdCounter;
}

// ========= UI FUNCTIONS =========

function clearScreen() {
  process.stdout.write('\x1Bc'); // Clear screen and reset cursor
}

function getFormattedTime() {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function printHeader() {
  const asciiArt = chalk.cyan.bold(`
 ███████╗ ██████╗██╗  ██╗███████╗██████╗ ██╗   ██╗██╗     ███████╗██████╗ 
 ██╔════╝██╔════╝██║  ██║██╔════╝██╔══██╗██║   ██║██║     ██╔════╝██╔══██╗
 ███████╗██║     ███████║█████╗  ██║  ██║██║   ██║██║     █████╗  ██████╔╝
 ╚════██║██║     ██╔══██║██╔══╝  ██║  ██║██║   ██║██║     ██╔══╝  ██╔══██╗
 ███████║╚██████╗██║  ██║███████╗██████╔╝╚██████╔╝███████╗███████╗██║  ██║
 ╚══════╝ ╚═════╝╚═╝  ╚═╝╚══════╝╚═════╝  ╚═════╝ ╚══════╝╚══════╝╚═╝  ╚═╝
`);
  const author = chalk.gray('                                           by Weelson');
  const time = chalk.yellow.bold(`                           ${getFormattedTime()}`);
  const separator = chalk.gray('─'.repeat(80));
  
  console.log(asciiArt);
  console.log(author);
  console.log(time);
  console.log(separator);
  console.log();
}

function refreshDisplay(message = null) {
  clearScreen();
  printHeader();
  if (message) {
    console.log(message);
    console.log();
  }
  if (typeof rl !== 'undefined' && rl.prompt) {
    rl.prompt();
  }
}

function log(msg, skipHeader = false) {
  if (!skipHeader) {
    refreshDisplay(msg);
  } else {
    console.log(msg);
    if (typeof rl !== 'undefined' && rl.prompt) {
      rl.prompt();
    }
  }
}

function stopAlarm() {
  if (!alarmProcess) {
    log(chalk.yellow('No alarm is currently playing.'));
    return false;
  }
  try {
    alarmProcess.kill();
    alarmProcess = null;
    log(chalk.green('Alarm stopped.'));
    return true;
  } catch (err) {
    log(chalk.red(`Error stopping alarm: ${err.message}`));
    return false;
  }
}

function playAlarm(label) {
  if (!fs.existsSync(alarmFile)) {
    log(chalk.red('alarm.mp3 not found in this folder. Add the file and try again.'));
    return;
  }

  if (alarmProcess) {
    log(chalk.yellow(`Alarm already playing. New alarm queued: ${label || 'alarm'}`));
    log(chalk.cyan('Tip: Type "stop the alarm" to stop the current alarm.'));
    return;
  }

  const escapedPath = alarmFile.replace(/'/g, "''");
  const volScalar = Math.max(0, Math.min(1, alarmVolume / 100)); // clamp to 0%-100% (0=mute)
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
    log(chalk.red(`Could not play alarm: ${err.message}`));
    alarmProcess = null;
  });

  log(chalk.red.bold(`ALARM${label ? ` (${label})` : ''}! Type "stop the alarm" to stop it.`));
}

function msUntil(time) {
  return Math.max(0, time.getTime() - Date.now());
}

function nextOccurrence(hour, minute) {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  
  // If target is in the past today, schedule for tomorrow
  if (target < now) {
    // Set to tomorrow's date first, then set the time
    // This properly handles DST transitions
    target.setDate(target.getDate() + 1);
    target.setHours(hour, minute, 0, 0);
  }
  
  return target;
}

function scheduleAt(timeStr, label, alarmId) {
  const match = timeStr.match(/^(\d{1,2}):(\d{1,2})$/);
  if (!match) {
    log(chalk.red('Time must be HH:MM or H:M in 24h format.'));
    return false;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    log(chalk.red('Time must be HH:MM in 24h format.'));
    return false;
  }

  const fireTime = nextOccurrence(hour, minute);
  let delay = msUntil(fireTime);
  
  // Protect against setTimeout 32-bit overflow (max ~24.8 days)
  if (delay > MAX_SETTIMEOUT_DELAY) {
    log(chalk.red('Time is too far in the future (>24.8 days). Please try again closer to the time.'));
    return false;
  }
  
  // Check for DST transition and warn user (don't try to auto-adjust as it's error-prone)
  const now = new Date();
  const dstOffset = now.getTimezoneOffset();
  const fireOffset = fireTime.getTimezoneOffset();
  if (dstOffset !== fireOffset) {
    // DST transition will occur between now and the alarm
    // Note: JavaScript Date handles DST transitions automatically for wall-clock time
    // The delay calculation using getTime() already accounts for this correctly
    const offsetDiff = Math.abs(dstOffset - fireOffset) * 60 * 1000;
    const offsetHours = offsetDiff / 3600000;
    log(chalk.yellow(`⚠ DST transition detected (${offsetHours.toFixed(1)}h offset change). Alarm set for wall-clock time ${fireTime.toLocaleTimeString()}.`));
  }
  
  // Register timeout BEFORE adding to pending (fixes race condition)
  const timeoutId = setTimeout(() => {
    try {
      playAlarm(label);
    } finally {
      // Always cleanup even if playAlarm fails
      if (alarmId) {
        removePending(alarmId);
        pendingTimeouts.delete(`alarm_${alarmId}`);
      }
    }
  }, delay);
  
  if (alarmId) {
    pendingTimeouts.set(`alarm_${alarmId}`, timeoutId);
  }
  log(chalk.green(`Scheduled for ${chalk.cyan(fireTime.toLocaleString())}${label ? ` (${chalk.yellow(label)})` : ''}.`));
  return true;
}

function scheduleIn(minutes, label, alarmId) {
  const mins = Number(minutes);
  if (!Number.isFinite(mins) || mins < 0.1 || mins > 1440) {
    log(chalk.red('Minutes must be a positive number between 0.1 and 1440.'));
    return false;
  }
  
  // Allow fractional minutes (minimum 0.1 = 6 seconds for user reaction time)
  const delayMs = Math.round(mins * 60 * 1000);
  
  // Protect against setTimeout 32-bit overflow (max ~24.8 days)
  if (delayMs > MAX_SETTIMEOUT_DELAY) {
    log(chalk.red('Delay exceeds maximum allowed (24.8 days). Please use a smaller value.'));
    return false;
  }
  
  const fireTime = new Date(Date.now() + delayMs);
  
  // Register timeout BEFORE adding to pending (fixes race condition)
  const timeoutId = setTimeout(() => {
    try {
      playAlarm(label);
    } finally {
      // Always cleanup even if playAlarm fails
      if (alarmId) {
        removePending(alarmId);
        pendingTimeouts.delete(`alarm_${alarmId}`);
      }
    }
  }, delayMs);
  
  if (alarmId) {
    pendingTimeouts.set(`alarm_${alarmId}`, timeoutId);
  }
  log(chalk.green(`Scheduled in ${chalk.cyan(mins)} minute(s) at ${chalk.cyan(fireTime.toLocaleString())}${label ? ` (${chalk.yellow(label)})` : ''}.`));
  return true;
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
        log(chalk.green('Daily alarms reset for new day.'));
      }
      scheduleReset(); // Reschedule reset for next day
    }, delay);
  }
  scheduleReset();
}

function scheduleDailyAlarm(dailyAlarmId, hour, minute, label) {
  // Validate parameters before scheduling
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    console.log(chalk.red(`Error: Invalid daily alarm time (${hour}:${minute}). Skipping this alarm.`));
    return;
  }
  
  function scheduleNext() {
    const fireTime = nextOccurrence(hour, minute);
    const delay = msUntil(fireTime);
    const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    
    // CRITICAL FIX: Protect against setTimeout 32-bit overflow (max ~24.8 days)
    // For daily alarms, this should never happen, but handle edge cases
    if (delay > MAX_SETTIMEOUT_DELAY) {
      // System time is critically wrong - log error and skip scheduling
      console.log(chalk.red(`Error: Daily alarm ${timeStr} delay exceeds maximum (${Math.floor(delay / 3600000)}h). System time may be incorrect. Skipping this alarm.`));
      return;
    }
    
    // Validate delay is reasonable (should be less than 25 hours for daily alarm)
    const MAX_DAILY_ALARM_DELAY = 90000000; // 25 hours in ms
    if (delay > MAX_DAILY_ALARM_DELAY) {
      console.log(chalk.red(`Error: Daily alarm ${timeStr} has unusual delay (${Math.floor(delay / 3600000)}h). System time may be incorrect. Skipping this alarm.`));
      return;
    }
    
    // Store timeout but allow it to be overwritten each day
    const timeoutId = setTimeout(() => {
      let alarmFired = false;
      try {
        if (dailyAlarmsEnabledToday) {
          playAlarm(`Daily: ${label || timeStr}`);
          alarmFired = true;
        }
      } catch (err) {
        console.log(chalk.red(`Error playing daily alarm: ${err.message}`));
        alarmFired = true; // Mark as fired even if playback failed
      } finally {
        // Always reschedule, even if playAlarm fails (FIX: ensures rescheduling happens after crash)
        scheduleNext();
      }
    }, delay);
    
    pendingTimeouts.set(`daily_${dailyAlarmId}`, timeoutId);
  }
  scheduleNext();
}

function initDailyAlarms() {
  dailyAlarms.forEach(({ id, hour, minute, label }) => {
    scheduleDailyAlarm(id, hour, minute, label);
  });
  scheduleDailyReset(); // Schedule the daily reset for midnight
  
  if (dailyAlarms.length > 0) {
    let msg = chalk.green('Daily alarm schedule initialized') + '\n';
    msg += chalk.gray('─'.repeat(80)) + '\n';
    msg += chalk.white.bold(` Time  │ Label\n`);
    msg += chalk.gray('─'.repeat(80)) + '\n';
    dailyAlarms.forEach(({ hour, minute, label }) => {
      const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`.padEnd(5);
      const labelStr = (label || '-').substring(0, 50);
      msg += chalk.white(` ${timeStr} │ ${labelStr}\n`);
    });
    msg += chalk.gray('─'.repeat(80));
    console.log(msg);
    console.log();
  } else {
    console.log(chalk.yellow('No daily alarms configured. Use "daily add <HH:MM> <label>" to add one.'));
    console.log();
  }
}

let heartbeatTimer = null;
let heartbeatFailures = 0;
let lastHeartbeatWarning = 0;
function startHeartbeat() {
  // Reset failure counter at start to prevent accumulation across restarts
  heartbeatFailures = 0;
  lastHeartbeatWarning = 0;
  
  const writeBeat = () => {
    try {
      fs.writeFileSync(heartbeatFile, `${Date.now()}`);
      if (heartbeatFailures > 0) {
        console.log(chalk.green('✓ Heartbeat restored.'));
      }
      heartbeatFailures = 0; // Reset on success
    } catch (err) {
      heartbeatFailures++;
      // Log at failure #3, then every 10 failures (13, 23, 33...), but throttle to once per 30s
      const shouldLogCount = heartbeatFailures === 3 || (heartbeatFailures > 3 && heartbeatFailures % 10 === 3);
      if (shouldLogCount) {
        const now = Date.now();
        if (now - lastHeartbeatWarning > HEARTBEAT_WARNING_INTERVAL_MS) {
          console.log(chalk.yellow(`⚠ Heartbeat write failed ${heartbeatFailures} times: ${err.message}`));
          lastHeartbeatWarning = now;
        }
      }
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
  const helpText = `
${chalk.cyan.bold('Available Commands:')}
${chalk.gray('─'.repeat(80))}

${chalk.yellow('Scheduling:')}
  ${chalk.white('in <minutes> [label]')}   ${chalk.gray('- alarm after N minutes (decimals ok, 0.1-1440)')}
  ${chalk.white('at <HH:MM> [label]')}     ${chalk.gray('- alarm at 24h clock time (tomorrow if time passed)')}
  
${chalk.yellow('Controls:')}
  ${chalk.white('stop the alarm')}         ${chalk.gray('- stop currently playing alarm')}
  ${chalk.white('vol [0-100]')}            ${chalk.gray('- show or set alarm volume (%, 0=mute)')}
  
${chalk.yellow('Daily Alarms:')}
  ${chalk.white('daily add <HH:MM> <label>')} ${chalk.gray('- add a daily recurring alarm')}
  ${chalk.white('daily modify')}           ${chalk.gray('- modify an existing daily alarm (interactive)')}
  ${chalk.white('daily delete')}           ${chalk.gray('- delete a daily alarm (interactive)')}
  ${chalk.white('disable daily')}          ${chalk.gray('- turn off daily alarms for today (auto-reset at midnight)')}
  ${chalk.white('enable daily')}           ${chalk.gray('- turn on daily alarms for today')}
  
${chalk.yellow('Information:')}
  ${chalk.white('list')}                   ${chalk.gray('- show pending timers')}
  ${chalk.white('remove')}                 ${chalk.gray('- remove a specific alarm by ID (interactive)')}
  ${chalk.white('status')}                 ${chalk.gray('- show scheduler status')}
  ${chalk.white('clear pending')}          ${chalk.gray('- clear all pending manual alarms')}
  ${chalk.white('help')}                   ${chalk.gray('- show this help')}
  ${chalk.white('quit/exit')}              ${chalk.gray('- stop scheduler')}

${chalk.gray('─'.repeat(80))}
`;
  refreshDisplay(helpText);
}

const pending = []; // Manual alarms
let alarmIdCounter = 0;

function nextAlarmId() {
  // Protect against overflow (reset at 1 billion to stay safe)
  if (alarmIdCounter >= MAX_COUNTER_VALUE) {
    // Find minimum unused ID to prevent collisions with existing alarms
    const usedIds = new Set([...pending.map(p => p.id), ...missedAlarms.map(m => m.id)]);
    let newId = 1;
    while (usedIds.has(newId) && newId < MAX_COUNTER_VALUE) {
      newId++;
    }
    // Validate we found a valid ID
    if (newId >= MAX_COUNTER_VALUE) {
      console.log(chalk.red(`Error: Cannot create alarm - all ${MAX_COUNTER_VALUE} IDs are in use.`));
      return null;
    }
    alarmIdCounter = newId - 1; // Will be incremented below
    console.log(chalk.yellow(`Counter overflow detected. Reset to ${newId}.`));
  }
  return ++alarmIdCounter;
}

function removePending(id) {
  const idx = pending.findIndex(p => p.id === id);
  if (idx !== -1) {
    pending.splice(idx, 1);
    savePending();
  }
}

function loadConfig() {
  try {
    if (fs.existsSync('config.json')) {
      const data = fs.readFileSync('config.json', 'utf8');
      config = JSON.parse(data);
      const loadedVol = config.volume ?? 100; // Use nullish coalescing to handle 0 correctly
      alarmVolume = Math.min(100, Math.max(0, Number.isFinite(Number(loadedVol)) ? Number(loadedVol) : 100));
      // Always trust the stored counters - they are more reliable than pending.json after crashes
      alarmIdCounter = config.alarmIdCounter ?? 0; // Restore counter to prevent ID collisions
      dailyAlarmIdCounter = config.dailyAlarmIdCounter ?? 0; // Restore daily alarm counter
      lastResetDate = config.lastResetDate ?? new Date().toDateString(); // Restore last reset date
      dailyAlarmsEnabledToday = config.dailyAlarmsEnabledToday ?? true; // Restore daily alarms state
      // Silent load - only log errors
    }
  } catch (err) {
    console.log(chalk.yellow(`Warning: Could not load config.json: ${err.message}`));
    // Try to restore from backup
    try {
      if (fs.existsSync('config.json.bak')) {
        const backupContent = fs.readFileSync('config.json.bak', 'utf8');
        const parsed = JSON.parse(backupContent);
        if (parsed && typeof parsed === 'object') {
          fs.copyFileSync('config.json.bak', 'config.json');
          config = parsed;
          alarmIdCounter = config.alarmIdCounter ?? 0;
          dailyAlarmIdCounter = config.dailyAlarmIdCounter ?? 0;
          console.log(chalk.green('Restored config.json from backup.'));
          return;
        }
      }
    } catch (e) {
      console.log(chalk.yellow(`Warning: Could not restore from backup: ${e.message}`));
    }
    config = { volume: 100, alarmIdCounter: 0, dailyAlarmIdCounter: 0 };
    alarmIdCounter = 0;
    dailyAlarmIdCounter = 0;
    lastResetDate = new Date().toDateString(); // Reset lastResetDate if config is corrupted
  }
}

function saveConfig() {
  try {
    // Validate data before saving
    const volumeToSave = Math.min(100, Math.max(0, Math.round(alarmVolume)));
    if (!Number.isFinite(volumeToSave) || volumeToSave < 0 || volumeToSave > 100) {
      console.log(chalk.yellow('Warning: Invalid volume value, skipping save.'));
      return;
    }
    
    // Validate counters to prevent corruption
    if (!Number.isFinite(alarmIdCounter) || alarmIdCounter < 0 || alarmIdCounter > MAX_COUNTER_VALUE) {
      console.log(chalk.yellow(`Warning: Invalid alarmIdCounter (${alarmIdCounter}), resetting to 0.`));
      alarmIdCounter = 0;
    }
    if (!Number.isFinite(dailyAlarmIdCounter) || dailyAlarmIdCounter < 0 || dailyAlarmIdCounter > MAX_COUNTER_VALUE) {
      console.log(chalk.yellow(`Warning: Invalid dailyAlarmIdCounter (${dailyAlarmIdCounter}), resetting to 0.`));
      dailyAlarmIdCounter = 0;
    }
    
    // Validate lastResetDate is a valid date string
    if (typeof lastResetDate !== 'string' || lastResetDate.length < 5) {
      console.log(chalk.yellow(`Warning: Invalid lastResetDate, resetting to today.`));
      lastResetDate = new Date().toDateString();
    }
    
    config.volume = volumeToSave;
    config.alarmIdCounter = alarmIdCounter; // Persist counter
    config.dailyAlarmIdCounter = dailyAlarmIdCounter; // Persist daily alarm counter
    config.lastResetDate = lastResetDate; // Persist last reset date
    config.dailyAlarmsEnabledToday = dailyAlarmsEnabledToday; // Persist daily alarms state
    
    // Use atomic write: write to temp file first, then rename
    const tempFile = 'config.json.tmp';
    fs.writeFileSync(tempFile, JSON.stringify(config, null, 2), 'utf8');
    fs.renameSync(tempFile, 'config.json');
  } catch (err) {
    console.log(chalk.yellow(`Warning: Could not save config.json: ${err.message}`));
  }
}

function savePending() {
  try {
    // Validate data structure before saving
    if (!Array.isArray(pending) || !Array.isArray(dailyAlarms) || !Array.isArray(missedAlarms)) {
      console.log(chalk.yellow('Warning: Invalid data structure, skipping save.'));
      return;
    }
    
    // Validate individual alarm objects
    const validPending = pending.filter(p => p.id && p.type && (p.type === 'in' || p.type === 'at'));
    const validDaily = dailyAlarms.filter(d => d.id && typeof d.hour === 'number' && typeof d.minute === 'number');
    const validMissed = missedAlarms.filter(m => m.id && m.type && (m.type === 'in' || m.type === 'at'));
    
    if (validPending.length !== pending.length || validDaily.length !== dailyAlarms.length || validMissed.length !== missedAlarms.length) {
      console.log(chalk.yellow(`Warning: Filtered out ${pending.length - validPending.length} invalid manual, ${dailyAlarms.length - validDaily.length} invalid daily, and ${missedAlarms.length - validMissed.length} invalid missed alarms.`));
    }
    
    // Backup before overwrite to prevent corruption
    if (fs.existsSync('pending.json')) {
      fs.copyFileSync('pending.json', 'pending.json.bak');
    }
    
    const data = {
      manual: validPending,
      daily: validDaily,
      missed: validMissed
    };
    
    // Atomic write: write to temp file first, then rename
    const tempFile = 'pending.json.tmp';
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempFile, 'pending.json');
  } catch (err) {
    console.log(chalk.yellow(`Warning: Could not save pending.json: ${err.message}`));
    // Try to restore from backup if save failed
    try {
      if (fs.existsSync('pending.json.bak')) {
        const backupContent = fs.readFileSync('pending.json.bak', 'utf8');
        // Validate backup is valid JSON before restoring
        const parsed = JSON.parse(backupContent);
        if (parsed && (Array.isArray(parsed) || (typeof parsed === 'object' && (parsed.manual || parsed.daily)))) {
          fs.copyFileSync('pending.json.bak', 'pending.json');
          console.log(chalk.green('Restored from backup.'));
        } else {
          console.log(chalk.yellow('Warning: Backup file is invalid (wrong structure). Skipping restore.'));
        }
      }
    } catch (e) {
      console.log(chalk.yellow(`Warning: Could not restore from backup: ${e.message}`));
    }
  }
}

function loadPending() {
  try {
    if (fs.existsSync('pending.json')) {
      const data = fs.readFileSync('pending.json', 'utf8');
      const loaded = JSON.parse(data);
      const now = Date.now();
      
      // Handle both old format (array) and new format (object with manual/daily/missed)
      const manualAlarms = Array.isArray(loaded) ? loaded : (loaded.manual || []);
      const loadedDailyAlarms = Array.isArray(loaded) ? [] : (loaded.daily || []);
      const loadedMissedAlarms = Array.isArray(loaded) ? [] : (loaded.missed || []);
      
      // Validate and sync ID counters to prevent collisions
      // Find the highest ID in all loaded alarms to ensure no duplicates
      const allAlarmIds = [
        ...manualAlarms.map(a => a.id || 0),
        ...loadedMissedAlarms.map(a => a.id || 0)
      ].filter(id => typeof id === 'number' && Number.isFinite(id) && id > 0);
      
      const allDailyIds = loadedDailyAlarms
        .map(a => a.id || 0)
        .filter(id => typeof id === 'number' && Number.isFinite(id) && id > 0);
      
      // Only sync if we have valid IDs (Math.max on empty array returns -Infinity)
      // Always sync to the higher value to prevent collisions, since pending.json may have
      // alarms created before a crash that didn't update config.json
      if (allAlarmIds.length > 0) {
        const maxId = Math.max(...allAlarmIds);
        if (maxId < MAX_COUNTER_VALUE) {
          // Use the higher of config or pending to prevent ID reuse
          // Sync to max (not max+1) since nextAlarmId() will increment before returning
          const newCounter = Math.max(alarmIdCounter, maxId);
          if (newCounter !== alarmIdCounter) {
            alarmIdCounter = newCounter;
            console.log(chalk.yellow(`Synced alarmIdCounter to ${alarmIdCounter} to prevent collisions.`));
          }
        }
      }
      
      if (allDailyIds.length > 0) {
        const maxDailyId = Math.max(...allDailyIds);
        if (maxDailyId < MAX_COUNTER_VALUE) {
          // Use the higher of config or pending to prevent ID reuse
          // Sync to max (not max+1) since nextDailyAlarmId() will increment before returning
          const newCounter = Math.max(dailyAlarmIdCounter, maxDailyId);
          if (newCounter !== dailyAlarmIdCounter) {
            dailyAlarmIdCounter = newCounter;
            console.log(chalk.yellow(`Synced dailyAlarmIdCounter to ${dailyAlarmIdCounter} to prevent collisions.`));
          }
        }
      }
      
      // Load daily alarms
      dailyAlarms = loadedDailyAlarms;
      if (dailyAlarms.length === 0 && alarmIdCounter === 0 && dailyAlarmIdCounter === 0) {
        // First time using new format (never run before), add default daily alarms
        // Only add defaults if BOTH counters are 0 to prevent duplicates on partial data loss
        // Ensure dailyAlarmIdCounter is set up first to avoid ID collisions
        // (it should already be loaded from config, but verify)
        if (dailyAlarmIdCounter === 0) {
          console.log(chalk.yellow('Warning: dailyAlarmIdCounter not initialized. Starting from 0.'));
        }
        
        const defaultSchedule = [
          { hour: 7, minute: 0, label: 'Morning' },
          { hour: 9, minute: 0, label: 'Mid-morning' },
          { hour: 10, minute: 0, label: 'Break' },
          { hour: 11, minute: 0, label: 'Pre-lunch' },
          { hour: 11, minute: 15, label: 'Lunch prep' },
          { hour: 12, minute: 30, label: 'Afternoon start' },
          { hour: 13, minute: 15, label: 'Break' },
          { hour: 14, minute: 30, label: 'Mid-afternoon' },
          { hour: 14, minute: 45, label: 'Break' },
          { hour: 16, minute: 0, label: 'Late afternoon' },
          { hour: 16, minute: 30, label: 'Break' },
          { hour: 18, minute: 0, label: 'Evening' },
          { hour: 18, minute: 15, label: 'Break' },
          { hour: 19, minute: 30, label: 'Night' },
          { hour: 19, minute: 45, label: 'Break' },
          { hour: 21, minute: 0, label: 'End of day' }
        ];
        
        defaultSchedule.forEach(({ hour, minute, label }) => {
          dailyAlarms.push({ id: nextDailyAlarmId(), hour, minute, label });
        });
        savePending();
      }
      
      // Restore manual pending alarms and move expired ones to missed
      manualAlarms.forEach(p => {
        if (p.type === 'in' && p.fireTime) {
          if (p.fireTime <= now) {
            // Check if alarm is way past (>7 days old)
            const ageMs = now - p.fireTime;
            if (!Number.isFinite(ageMs)) {
              console.log(chalk.yellow(`Warning: Alarm "${p.label || 'alarm'}" has invalid fireTime. Marking as missed.`));
            } else if (ageMs > SEVEN_DAYS_MS) {
              console.log(chalk.yellow(`Warning: Alarm "${p.label || 'alarm'}" is ${Math.floor(ageMs / 86400000)} days old. Marking as missed.`));
            }
            missedAlarms.push(p);
          } else {
            const delay = p.fireTime - now;
            // Protect against setTimeout 32-bit overflow
            if (delay > MAX_SETTIMEOUT_DELAY) {
              console.log(chalk.yellow(`Warning: Alarm "${p.label || 'alarm'}" delay exceeds limit. Marking as missed.`));
              missedAlarms.push(p);
              return;
            }
            const timeoutId = setTimeout(() => {
              playAlarm(`${p.label || 'alarm'}`);
              if (p.id) {
                removePending(p.id);
                pendingTimeouts.delete(`alarm_${p.id}`);
              }
            }, delay);
            pendingTimeouts.set(`alarm_${p.id}`, timeoutId);
            pending.push(p);
          }
        } else if (p.type === 'at' && p.when) {
          const [hour, minute] = p.when.split(':').map(Number);
          
          // Use stored fireTime if available to properly detect missed alarms
          if (p.fireTime && typeof p.fireTime === 'number' && Number.isFinite(p.fireTime)) {
            // CRITICAL FIX: Check if alarm is way past (>7 days old)
            // Old alarms more than a week past should be marked as missed
            const ageMs = now - p.fireTime;
            if (Number.isFinite(ageMs) && ageMs > SEVEN_DAYS_MS) {
              console.log(chalk.yellow(`Warning: Alarm "${p.label || 'alarm'}" is ${Math.floor(ageMs / 86400000)} days old. Marking as missed.`));
              missedAlarms.push(p);
            } else if (p.fireTime <= now) {
              // Recent missed alarm (within 7 days)
              missedAlarms.push(p);
            } else {
              // Future alarm - reschedule with stored fireTime
              const delay = p.fireTime - now;
              // Protect against setTimeout 32-bit overflow
              if (delay > MAX_SETTIMEOUT_DELAY) {
                console.log(chalk.yellow(`Warning: Alarm "${p.label || 'alarm'}" delay exceeds limit. Marking as missed.`));
                missedAlarms.push(p);
                return;
              }
              const timeoutId = setTimeout(() => {
                playAlarm(`${p.label || 'alarm'}`);
                if (p.id) {
                  removePending(p.id);
                  pendingTimeouts.delete(`alarm_${p.id}`);
                }
              }, delay);
              pendingTimeouts.set(`alarm_${p.id}`, timeoutId);
              pending.push(p);
            }
          } else {
            // No stored fireTime - calculate next occurrence and store it
            const fireTime = nextOccurrence(hour, minute);
            p.fireTime = fireTime.getTime(); // Store to prevent race conditions
            const delay = msUntil(fireTime);
            const timeoutId = setTimeout(() => {
              playAlarm(`${p.label || 'alarm'}`);
              if (p.id) {
                removePending(p.id);
                pendingTimeouts.delete(`alarm_${p.id}`);
              }
            }, delay);
            pendingTimeouts.set(`alarm_${p.id}`, timeoutId);
            pending.push(p);
          }
        }
      });

      // Merge any stored missed alarms (keeping unique by id)
      // Auto-expire missed alarms older than 90 days to prevent storage bloat
      const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
      const missedById = new Map();
      let expiredCount = 0;
      [...loadedMissedAlarms, ...missedAlarms].forEach(m => {
        if (m && m.id) {
          // Check if alarm is older than 90 days
          if (m.fireTime && typeof m.fireTime === 'number' && Number.isFinite(m.fireTime)) {
            const ageMs = now - m.fireTime;
            if (Number.isFinite(ageMs) && ageMs > NINETY_DAYS_MS) {
              expiredCount++;
              return; // Skip this old alarm
            }
          }
          missedById.set(m.id, m);
        }
      });
      missedAlarms.length = 0;
      missedById.forEach(m => missedAlarms.push(m));
      if (expiredCount > 0) {
        console.log(chalk.yellow(`Auto-expired ${expiredCount} missed alarm(s) older than 90 days.`));
      }
      
      // Silent load - only show if there are pending alarms
      if (pending.length > 0) {
        console.log(chalk.cyan(`Loaded ${pending.length} pending alarm(s) from storage.`));
        console.log();
      }
      if (dailyAlarms.length > 0) {
        console.log(chalk.cyan(`Loaded ${dailyAlarms.length} daily alarm(s) from storage.`));
        console.log();
      }
      
      // Save state to remove any missed alarms from persistent storage
      savePending();
    }
  } catch (err) {
    console.log(chalk.yellow(`Warning: Could not load pending.json: ${err.message}`));
    // Try to restore from backup
    try {
      if (fs.existsSync('pending.json.bak')) {
        const backupContent = fs.readFileSync('pending.json.bak', 'utf8');
        // Validate backup is valid JSON before restoring
        const parsed = JSON.parse(backupContent);
        if (parsed && (Array.isArray(parsed) || (typeof parsed === 'object' && (parsed.manual || parsed.daily)))) {
          fs.copyFileSync('pending.json.bak', 'pending.json');
          console.log(chalk.green('Restored from backup.'));
        } else {
          console.log(chalk.yellow('Warning: Backup file is invalid (wrong structure). Skipping restore.'));
        }
      }
    } catch (e) {
      console.log(chalk.yellow(`Warning: Could not restore from backup: ${e.message}`));
    }
  }
}

function addPending(type, when, label, fireTime = null) {
  // CRITICAL FIX: Convert fireTime to timestamp for consistent comparison
  let fireTimeMs = null;
  if (fireTime) {
    if (typeof fireTime === 'number') {
      // Validate that it's a reasonable millisecond timestamp (not in seconds or a date string)
      if (fireTime < 0 || !Number.isFinite(fireTime)) {
        console.log(chalk.yellow(`Warning: Invalid fireTime value ${fireTime}. Ignoring.`));
        fireTimeMs = null;
      } else if (fireTime < 1000000000000) {
        // Likely in seconds, not milliseconds - this is an error
        console.log(chalk.yellow(`Warning: fireTime appears to be in seconds, not milliseconds. Treating as null.`));
        fireTimeMs = null;
      } else {
        fireTimeMs = fireTime;
      }
    } else if (fireTime instanceof Date) {
      fireTimeMs = fireTime.getTime();
    } else {
      console.log(chalk.yellow(`Warning: fireTime is invalid type. Ignoring.`));
      fireTimeMs = null;
    }
  }
  
  // Prevent duplicate 'at' alarms
  if (type === 'at') {
    const exists = pending.some(p => p.type === type && p.when === when && (p.label || '') === (label || ''));
    if (exists) {
      log(chalk.yellow('This alarm is already scheduled.'));
      return null;
    }
  } else if (type === 'in' && fireTimeMs) {
    // Prevent spam: reject if identical alarm (same time AND label) was created in last 1000ms
    const recentDuplicate = pending.find(p => {
      if (p.type !== 'in' || !p.fireTime || !Number.isFinite(p.fireTime)) return false;
      const timeDiff = Math.abs(p.fireTime - fireTimeMs);
      // Only check time difference if it's a valid number
      if (!Number.isFinite(timeDiff)) return false;
      // Both time AND label must match for duplicate detection
      const labelMatch = (p.label || '') === (label || '');
      return timeDiff < DUPLICATE_ALARM_WINDOW_MS && labelMatch;
    });
    if (recentDuplicate) {
      log(chalk.yellow('Duplicate alarm detected (same time and label within 1s). Please wait or use different label.'));
      return null;
    }
  }
  
  // Warn if label is too long (after validation passes)
  if (label && label.length > 50) {
    console.log(chalk.yellow(`⚠ Label will be truncated to 50 characters in displays.`));
  }
  
  // FIX: Generate ID first, then save config immediately to persist counter before adding to array
  const newId = nextAlarmId();
  if (newId === null) {
    log(chalk.red('Cannot create alarm: ID limit reached.'));
    return null;
  }
  saveConfig(); // CRITICAL: Persist counter immediately to prevent ID collisions on crash
  
  const entry = { id: newId, type, when, label };
  if (fireTimeMs) {
    entry.fireTime = fireTimeMs;
  }
  pending.push(entry);
  savePending();
  return entry; // Return the entry with ID to avoid race condition
}

function showPending() {
  const hasPending = pending.length > 0;
  const dailyStatus = dailyAlarmsEnabledToday ? chalk.green('ENABLED') : chalk.red('DISABLED');
  
  let output = '';
  
  // Daily alarms section
  output += chalk.cyan.bold('Daily Alarms: ') + dailyStatus + '\n';
  if (dailyAlarms.length > 0) {
    output += chalk.gray('─'.repeat(80)) + '\n';
    output += chalk.white.bold(` Time  │ Label\n`);
    output += chalk.gray('─'.repeat(80)) + '\n';
    dailyAlarms.forEach(({ hour, minute, label }) => {
      const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`.padEnd(5);
      const labelStr = (label || '-').substring(0, 50).padEnd(50);
      output += chalk.white(` ${timeStr} │ ${labelStr}\n`);
    });
    output += chalk.gray('─'.repeat(80)) + '\n';
  } else {
    output += chalk.gray('  No daily alarms configured.\n');
  }
  output += '\n';
  
  // Manual alarms section
  if (!hasPending) {
    output += chalk.yellow('No manual alarms scheduled.\n');
    refreshDisplay(output);
    return;
  }
  
  output += chalk.cyan.bold('Manual Alarms:\n');
  output += chalk.gray('─'.repeat(80)) + '\n';
  
  // Table header
  const colID = 'ID';
  const colType = 'Type';
  const colTime = 'Time';
  const colLabel = 'Label';
  const colFiresAt = 'Fires At';
  
  const now = Date.now();
  
  // Remove expired alarms from pending array (not just filter for display)
  // CRITICAL: Clear timeouts BEFORE removing to prevent phantom playback
  let expiredCount = 0;
  const idsToRemove = [];
  
  for (let i = pending.length - 1; i >= 0; i--) {
    const p = pending[i];
    let shouldRemove = false;
    
    if (p.fireTime && p.fireTime <= now) {
      // Check if 'at' alarm is very old (>7 days) and should be removed
      if (p.type === 'at') {
        const ageMs = now - p.fireTime;
        if (Number.isFinite(ageMs) && ageMs > SEVEN_DAYS_MS) {
          shouldRemove = true;
        } else {
          shouldRemove = false; // Recent 'at' alarm, keep for rescheduling
        }
      } else {
        shouldRemove = true; // 'in' type alarm is expired
      }
    } else if (!p.fireTime && p.type === 'at' && p.when) {
      // For old alarms without fireTime, recalculate and keep
      shouldRemove = false;
    }
    
    if (shouldRemove) {
      idsToRemove.push(p.id);
    }
  }
  
  // First clear all timeouts atomically
  idsToRemove.forEach(id => {
    const timeoutId = pendingTimeouts.get(`alarm_${id}`);
    if (timeoutId) {
      clearTimeout(timeoutId);
      pendingTimeouts.delete(`alarm_${id}`);
    }
  });
  
  // Then remove from array by ID (safe against array modifications)
  idsToRemove.forEach(id => {
    const idx = pending.findIndex(p => p.id === id);
    if (idx !== -1) {
      pending.splice(idx, 1);
      expiredCount++;
    }
  });
  
  if (expiredCount > 0) {
    savePending();
  }
  
  // Filter for display (should now match pending array)
  const activePending = pending.filter((p) => {
    // CRITICAL FIX: Use stored fireTime for accurate detection
    // Don't recalculate - use what was stored when alarm was created
    if (p.fireTime) {
      // If fireTime exists, use it directly (handles both 'in' and 'at' types)
      return p.fireTime > now;
    }
    
    // Fallback: For old alarms without fireTime, recalculate
    if (p.type === 'at' && p.when) {
      const match = p.when.match(/^(\d{1,2}):(\d{2})$/);
      if (match) {
        const hour = Number(match[1]);
        const minute = Number(match[2]);
        const fireTime = nextOccurrence(hour, minute);
        // For 'at' alarms, always show next occurrence (never filter out)
        // The alarm reschedules for next day automatically
        return true;
      }
    }
    
    // Unknown type or invalid format - keep it to avoid hiding errors
    return true;
  });
  
  let displayIdx = 1;
  
  activePending.forEach((p) => {
      const id = String(displayIdx).padEnd(4);
      const type = p.type.toUpperCase().padEnd(6);
      const time = (p.when || '').padEnd(10);
      const label = (p.label || '-').substring(0, 20).padEnd(20);
      
      let firesAt = '-';
      if (p.fireTime) {
        const fireDate = new Date(p.fireTime);
        firesAt = fireDate.toLocaleString();
      } else if (p.type === 'at' && p.when) {
        const match = p.when.match(/^(\d{1,2}):(\d{2})$/);
        if (match) {
          const hour = Number(match[1]);
          const minute = Number(match[2]);
          const fireDate = nextOccurrence(hour, minute);
          firesAt = fireDate.toLocaleString();
        }
      }
      firesAt = firesAt.substring(0, 25).padEnd(25);
      
      output += chalk.white(` ${id} │ ${type} │ ${time} │ ${label} │ ${firesAt}\n`);
      displayIdx++;
  });
  
  output += chalk.gray('─'.repeat(80)) + '\n';
  refreshDisplay(output);
}

// Track time changes (useful for future features like auto-refresh on idle)
let lastDisplayedTime = getFormattedTime();
setInterval(() => {
  const currentTime = getFormattedTime();
  if (currentTime !== lastDisplayedTime) {
    lastDisplayedTime = currentTime;
    // Time changed - clock updates on next command
  }
}, 60000); // Check every minute

const wasRestarted = process.env.SCHEDULER_RESTARTED === 'true';

// Initial screen setup
clearScreen();
printHeader();

if (wasRestarted) {
  console.log(chalk.red.bold('App exited in an unexpected way and was restarted by the watchdog'));
  console.log();
  delete process.env.SCHEDULER_RESTARTED;
}

console.log(chalk.green.bold('Study Scheduler ready.') + chalk.gray(' Type "help" for commands.'));
if (!fs.existsSync(alarmFile)) {
  console.log(chalk.yellow('Place alarm.mp3 in this folder so the alarm can play.'));
}
console.log();

rl.setPrompt(chalk.cyan('-> '));
rl.prompt();

loadConfig();
loadPending();

// Check if we're on a new day and reset daily alarms BEFORE initializing them
// This ensures dailyAlarmsEnabledToday is correct before scheduling
const today = new Date().toDateString();
if (today !== lastResetDate) {
  lastResetDate = today;
  dailyAlarmsEnabledToday = true;
  saveConfig(); // Persist the daily state
  console.log(chalk.green('New day detected. Daily alarms reset to ENABLED.'));
  console.log();
}

// Clear any existing daily alarm timeouts before reinitializing
// CRITICAL: This prevents duplicate daily alarms from firing twice on restart.
// If the app crashes and restarts within the same day, we must clear old setTimeout IDs
// before calling initDailyAlarms(), which will reschedule them for the correct next occurrence.
// Without this, daily alarms could fire multiple times in the same day.
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
  if (missedAlarms.length > 0) {
    console.log(chalk.red(`You have ${missedAlarms.length} missed alarm(s). Type "solve missed" to handle them.`));
  }
  if (input.toLowerCase() === 'stop the alarm') {
    stopAlarm();
    return;
  }
  
  const [cmd, ...rest] = input.split(/\s+/);

  switch (cmd.toLowerCase()) {
    case 'solve': {
      if (rest[0] && rest[0].toLowerCase() === 'missed') {
        return solveMissedInteractive();
      }
      log(chalk.yellow('Usage: solve missed'));
      break;
    }
    case 'in': {
      const [mins, ...labelParts] = rest;
      if (!mins) {
        log(chalk.red('Usage: in <minutes> [label]'));
        break;
      }
      const minsNumber = Number(mins);
      if (!Number.isFinite(minsNumber) || minsNumber < 0.1 || minsNumber > 1440) {
        log(chalk.red('Minutes must be a positive number between 0.1 and 1440.'));
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
        log(chalk.red('Usage: at <HH:MM> [label]'));
        break;
      }
      const label = labelParts.join(' ').trim();
      // Parse time and calculate fireTime - enforce 2-digit minutes
      const match = time.match(/^(\d{1,2}):(\d{2})$/);
      if (match) {
        const hour = Number(match[1]);
        const minute = Number(match[2]);
        // Validate hour and minute ranges
        if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
          log(chalk.red('Time must be HH:MM in 24h format (00:00 to 23:59).'));
          break;
        }
        const fireTime = nextOccurrence(hour, minute);
        const entry = addPending('at', time, label, fireTime);
        if (entry) {
          scheduleAt(time, label, entry.id);
        }
      } else {
        log(chalk.red('Time must be HH:MM in 24h format (e.g., 9:05 not 9:5).'));
      }
      break;
    }
    case 'daily': {
      const subCmd = rest[0] ? rest[0].toLowerCase() : '';
      
      if (subCmd === 'add') {
        const [time, ...labelParts] = rest.slice(1);
        if (!time) {
          log(chalk.red('Usage: daily add <HH:MM> <label>'));
          break;
        }
        
        const match = time.match(/^(\d{1,2}):(\d{2})$/);
        if (!match) {
          log(chalk.red('Time must be HH:MM in 24h format (e.g., 7:05 not 7:5).'));
          break;
        }
        
        const hour = Number(match[1]);
        const minute = Number(match[2]);
        if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
          log(chalk.red('Time must be HH:MM in 24h format (00:00 to 23:59).'));
          break;
        }
        
        // Check for duplicate daily alarm at same time
        const duplicate = dailyAlarms.find(a => a.hour === hour && a.minute === minute);
        if (duplicate) {
          log(chalk.yellow(`Daily alarm already exists at ${time}${duplicate.label ? ` (${duplicate.label})` : ''}. Use "daily modify" to change it.`));
          break;
        }
        
        const label = labelParts.join(' ').trim() || '';
        const dailyAlarmId = nextDailyAlarmId();
        if (dailyAlarmId === null) {
          log(chalk.red('Cannot create daily alarm: ID limit reached.'));
          break;
        }
        dailyAlarms.push({ id: dailyAlarmId, hour, minute, label });
        dailyAlarms.sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
        saveConfig(); // Save config to persist dailyAlarmIdCounter
        savePending();
        
        // Schedule the new daily alarm
        scheduleDailyAlarm(dailyAlarmId, hour, minute, label);
        
        log(chalk.green(`Daily alarm added: ${time}${label ? ` - ${label}` : ''}`));
        break;
      }
      
      if (subCmd === 'modify') {
        if (promptActive) {
          log(chalk.yellow('Another prompt is already active. Please wait.'));
          break;
        }
        
        if (dailyAlarms.length === 0) {
          log(chalk.yellow('No daily alarms to modify.'));
          break;
        }
        
        // Display daily alarms with IDs
        let output = chalk.cyan.bold('Daily Alarms:\n');
        output += chalk.gray('─'.repeat(80)) + '\n';
        output += chalk.white.bold(` ID │ Time  │ Label\n`);
        output += chalk.gray('─'.repeat(80)) + '\n';
        dailyAlarms.forEach(({ id, hour, minute, label }) => {
          const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
          const labelStr = (label || '-').substring(0, 45);
          output += chalk.white(` ${String(id).padEnd(2)} │ ${timeStr} │ ${labelStr}\n`);
        });
        output += chalk.gray('─'.repeat(80)) + '\n';
        refreshDisplay(output);
        
        // Prompt for ID
        promptActive = true;
        rl.question(chalk.yellow('Enter ID to modify: '), (idInput) => {
          try {
            const id = Number(idInput.trim());
            const alarmToModify = dailyAlarms.find(a => a.id === id);
            
            if (!alarmToModify) {
              log(chalk.red('Wrong ID'));
              return;
            }
            
            // Prompt for new time
            rl.question(chalk.yellow(`New time (HH:MM) [${String(alarmToModify.hour).padStart(2, '0')}:${String(alarmToModify.minute).padStart(2, '0')}]: `), (timeInput) => {
              try {
                const timeTrimmed = timeInput.trim();
                let newHour = alarmToModify.hour;
                let newMinute = alarmToModify.minute;
                
                if (timeTrimmed) {
                  const match = timeTrimmed.match(/^(\d{1,2}):(\d{2})$/);
                  if (!match || Number(match[1]) < 0 || Number(match[1]) > 23 || Number(match[2]) < 0 || Number(match[2]) > 59) {
                    log(chalk.red('Invalid time format (use HH:MM, e.g., 9:05). Changes cancelled.'));
                    return;
                  }
                  newHour = Number(match[1]);
                  newMinute = Number(match[2]);
                }
                
                // Check for duplicate with other alarms after parsing (or using existing time)
                // This saves user time by not prompting for label if there's a conflict
                const duplicate = dailyAlarms.find(a => a.id !== id && a.hour === newHour && a.minute === newMinute);
                if (duplicate) {
                  log(chalk.red(`Another daily alarm already exists at ${String(newHour).padStart(2, '0')}:${String(newMinute).padStart(2, '0')}${duplicate.label ? ` (${duplicate.label})` : ''}. Changes cancelled.`));
                  return;
                }
                
                // Prompt for new label
                rl.question(chalk.yellow(`New label [${alarmToModify.label || '-'}]: `), (labelInput) => {
                  try {
                    const labelTrimmed = labelInput.trim();
                    const newLabel = labelTrimmed === '' ? alarmToModify.label : labelTrimmed;
                    
                    // Store old values for rollback
                    const oldHour = alarmToModify.hour;
                    const oldMinute = alarmToModify.minute;
                    const oldLabel = alarmToModify.label;
                    
                    try {
                      // Update the alarm
                      alarmToModify.hour = newHour;
                      alarmToModify.minute = newMinute;
                      alarmToModify.label = newLabel;
                      
                      // Re-sort
                      dailyAlarms.sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
                      savePending();
                      
                      // Clear old timeout and reschedule
                      const oldTimeout = pendingTimeouts.get(`daily_${id}`);
                      if (oldTimeout) {
                        clearTimeout(oldTimeout);
                        pendingTimeouts.delete(`daily_${id}`);
                      }
                      scheduleDailyAlarm(id, newHour, newMinute, newLabel);
                      
                        log(chalk.green(`Daily alarm modified: ${String(newHour).padStart(2, '0')}:${String(newMinute).padStart(2, '0')}${newLabel ? ` - ${newLabel}` : ''}`));
                      promptActive = false;
                    } catch (err) {
                      // Rollback on error
                      alarmToModify.hour = oldHour;
                      alarmToModify.minute = oldMinute;
                      alarmToModify.label = oldLabel;
                      dailyAlarms.sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
                      log(chalk.red(`Failed to modify alarm: ${err.message}. Changes reverted.`));
                      promptActive = false;
                    }
                  } catch (err) {
                    log(chalk.red(`Error during label modification: ${err.message}`));
                    promptActive = false;
                  }
                });
              } catch (err) {
                log(chalk.red(`Error during time modification: ${err.message}`));
              }
            });
          } catch (err) {
            log(chalk.red(`Error: ${err.message}`));
          }
        });
        return; // Don't continue switch, waiting for async prompts
      }
      
      if (subCmd === 'delete') {
        if (promptActive) {
          log(chalk.yellow('Another prompt is already active. Please wait.'));
          break;
        }
        
        if (dailyAlarms.length === 0) {
          log(chalk.yellow('No daily alarms to delete.'));
          break;
        }
        
        // Display daily alarms with IDs
        let output = chalk.cyan.bold('Daily Alarms:\n');
        output += chalk.gray('─'.repeat(80)) + '\n';
        output += chalk.white.bold(` ID │ Time  │ Label\n`);
        output += chalk.gray('─'.repeat(80)) + '\n';
        dailyAlarms.forEach(({ id, hour, minute, label }) => {
          const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
          const labelStr = (label || '-').substring(0, 45);
          output += chalk.white(` ${String(id).padEnd(2)} │ ${timeStr} │ ${labelStr}\n`);
        });
        output += chalk.gray('─'.repeat(80)) + '\n';
        refreshDisplay(output);
        
        // Prompt for ID
        promptActive = true;
        rl.question(chalk.yellow('Enter ID to delete: '), (idInput) => {
          const id = Number(idInput.trim());
          const idx = dailyAlarms.findIndex(a => a.id === id);
          
          if (idx === -1) {
            log(chalk.red('Wrong ID'));
            return;
          }
          
          const deleted = dailyAlarms[idx];
          dailyAlarms.splice(idx, 1);
          savePending();
          
          // Clear timeout
          const timeout = pendingTimeouts.get(`daily_${id}`);
          if (timeout) {
            clearTimeout(timeout);
            pendingTimeouts.delete(`daily_${id}`);
          }
          
          log(chalk.green(`Daily alarm deleted: ${String(deleted.hour).padStart(2, '0')}:${String(deleted.minute).padStart(2, '0')}${deleted.label ? ` - ${deleted.label}` : ''}`));
          promptActive = false;
        });
        return; // Don't continue switch, waiting for async prompt
      }
      
      log(chalk.yellow('Usage: daily add <HH:MM> <label> | daily modify | daily delete'));
      break;
    }
    case 'disable':
    case 'enable': {
      if (!rest[0] || rest[0].toLowerCase() !== 'daily') {
        log(chalk.yellow(`Use "${cmd.toLowerCase()} daily" to turn ${cmd.toLowerCase()} daily alarms.`));
        break;
      }
      dailyAlarmsEnabledToday = cmd.toLowerCase() === 'enable';
      saveConfig(); // Persist the toggle state
      const statusColor = dailyAlarmsEnabledToday ? chalk.green : chalk.red;
      const statusText = dailyAlarmsEnabledToday ? 'ENABLED' : 'DISABLED';
      log(chalk.cyan('Daily alarms ') + statusColor.bold(statusText) + chalk.cyan(' for today.'));
      break;
    }
    case 'list':
      showPending();
      break;
    case 'remove': {
      if (promptActive) {
        log(chalk.yellow('Another prompt is already active. Please wait.'));
        break;
      }
      
      if (pending.length === 0) {
        log(chalk.yellow('No manual alarms to remove.'));
        break;
      }
      
      // Display manual alarms with their actual IDs
      let output = chalk.cyan.bold('Manual Alarms:\n');
      output += chalk.gray('─'.repeat(80)) + '\n';
      output += chalk.white.bold(` ID │ Type  │ Time       │ Label                │ Fires At\n`);
      output += chalk.gray('─'.repeat(80)) + '\n';
      
      pending.forEach((p) => {
        const id = String(p.id).padEnd(3);
        const type = p.type.toUpperCase().padEnd(5);
        const time = (p.when || '').padEnd(10);
        const label = (p.label || '-').substring(0, 20).padEnd(20);
        
        let firesAt = '-';
        if (p.fireTime) {
          const fireDate = new Date(p.fireTime);
          firesAt = fireDate.toLocaleString();
        } else if (p.type === 'at' && p.when) {
          const match = p.when.match(/^(\d{1,2}):(\d{2})$/);
          if (match) {
            const hour = Number(match[1]);
            const minute = Number(match[2]);
            const fireDate = nextOccurrence(hour, minute);
            firesAt = fireDate.toLocaleString();
          }
        }
        firesAt = firesAt.substring(0, 25);
        
        output += chalk.white(` ${id} │ ${type} │ ${time} │ ${label} │ ${firesAt}\n`);
      });
      
      output += chalk.gray('─'.repeat(80)) + '\n';
      refreshDisplay(output);
      
      // Prompt for ID
      promptActive = true;
      rl.question(chalk.yellow('Enter ID to remove: '), (idInput) => {
        const id = Number(idInput.trim());
        const alarmToRemove = pending.find(p => p.id === id);
        
        if (!alarmToRemove) {
          log(chalk.red('wrong id'));
          return;
        }
        
        // Clear timeout
        const timeoutId = pendingTimeouts.get(`alarm_${id}`);
        if (timeoutId) {
          clearTimeout(timeoutId);
          pendingTimeouts.delete(`alarm_${id}`);
        }
        
        // Remove from pending
        removePending(id);
        
        log(chalk.green(`Alarm removed: ${alarmToRemove.type} ${alarmToRemove.when || ''}${alarmToRemove.label ? ` - ${alarmToRemove.label}` : ''}`));
        promptActive = false;
      });
      return; // Don't continue switch, waiting for async prompt
    }
    case 'clear':
      if (rest[0] && rest[0].toLowerCase() === 'pending') {
        if (promptActive) {
          log(chalk.yellow('Another prompt is already active. Please wait.'));
          break;
        }
        
        if (pending.length === 0) {
          log(chalk.yellow('No pending alarms to clear.'));
          break;
        }
        
        // Capture count at display time
        const pendingCount = pending.length;
        refreshDisplay(`${chalk.yellow.bold('⚠ Warning:')} This will clear ${pendingCount} pending alarm(s).`);
        promptActive = true;
        rl.question(chalk.yellow('Type YES to confirm: '), (confirmation) => {
          if (confirmation.trim().toUpperCase() === 'YES') {
            // Recount in case alarms fired during confirmation
            const actualCount = pending.length;
            
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
            log(chalk.green(`✓ Cleared ${actualCount} pending alarm(s).`));
            promptActive = false;
          } else {
            log(chalk.cyan('Cancelled.'));
            promptActive = false;
          }
        });
        return; // Don't continue switch, waiting for async prompt
      } else {
        log(chalk.yellow('Use "clear pending" to clear all pending manual alarms.'));
      }
      break;
    case 'status': {
      let statusMsg = '';
      statusMsg += chalk.cyan.bold('Scheduler Status\n');
      statusMsg += chalk.gray('─'.repeat(80)) + '\n';
      statusMsg += chalk.white('Status: ') + chalk.green('Running') + '\n';
      statusMsg += chalk.white('Volume: ') + chalk.yellow(`${alarmVolume}%`) + '\n';
      const dailyStatus = dailyAlarmsEnabledToday ? chalk.green('ENABLED') : chalk.red('DISABLED');
      statusMsg += chalk.white('Daily alarms: ') + dailyStatus + '\n';
      statusMsg += chalk.gray('Next daily reset: midnight (automatic)\n');
      statusMsg += chalk.gray('─'.repeat(80));
      refreshDisplay(statusMsg);
      break;
    }
    case 'vol': {
      if (!rest[0]) {
        log(chalk.cyan('Current alarm volume: ') + chalk.yellow(`${alarmVolume}%`));
        break;
      }
      const vol = Number(rest[0]);
      if (!Number.isFinite(vol)) {
        log(chalk.red('Volume must be a valid number.'));
      } else if (vol < 0) {
        log(chalk.red('Volume cannot be negative. Use 0 to mute.'));
      } else if (vol > 100) {
        log(chalk.red('Volume cannot exceed 100%.'));
      } else {
        const inputVol = Math.floor(vol); // Floor before assigning
        if (inputVol !== vol && vol !== Math.floor(vol)) {
          log(chalk.yellow(`Note: Decimal volume ${vol}% rounded down to ${inputVol}%`));
        }
        alarmVolume = inputVol;
        saveConfig();
        log(chalk.green(`Alarm volume set to `) + chalk.yellow(`${alarmVolume}%`) + chalk.green('.'));
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
        // Verify stop flag was written successfully
        if (!fs.existsSync(stopFlagFile)) {
          log(chalk.red('Error: Stop flag could not be verified. Watchdog may restart the scheduler.'));
        }
      } catch (e) {
        log(chalk.yellow(`Warning: Could not write stop flag: ${e.message}`));
      }
      stopHeartbeat();
      // Clear all pending timeouts atomically
      pendingTimeouts.forEach((timeoutId) => {
        clearTimeout(timeoutId);
      });
      pendingTimeouts.clear();
      // Don't clear pending array - it's persisted to disk
      log(chalk.green.bold('Goodbye!'));
      try {
        rl.close();
      } catch (e) {
        log(chalk.yellow(`Warning: Error closing interface: ${e.message}`));
      }
      return;
    }
    default:
      log(chalk.red('Unknown command. ') + chalk.gray('Type "help" for options.'));
  }
}

// Flag to prevent overlapping interactive prompts
let promptActive = false;

rl.on('line', handle);
rl.on('close', () => process.exit(process.exitCode || 0));

process.on('uncaughtException', (err) => {
  console.log(chalk.red.bold(`Fatal error: ${err.message}`));
  process.exit(1);
});

// ===== Missed alarms resolution =====
function listMissedAlarms() {
  let output = chalk.red.bold('Missed Alarms:\n');
  output += chalk.gray('─'.repeat(80)) + '\n';
  output += chalk.white.bold(' ID  │ Type │ Time                       │ Label               \n');
  output += chalk.gray('─'.repeat(80)) + '\n';
  missedAlarms.forEach((m) => {
    const id = String(m.id).padEnd(3);
    const type = m.type.toUpperCase().padEnd(4);
    let timeStr = '-';
    if (m.type === 'at') {
      timeStr = (m.when || '-');
    } else if (m.fireTime) {
      timeStr = new Date(m.fireTime).toLocaleString();
    }
    timeStr = timeStr.substring(0, 25).padEnd(25);
    const label = (m.label || '-').substring(0, 20).padEnd(20);
    output += chalk.white(` ${id} │ ${type} │ ${timeStr} │ ${label}\n`);
  });
  output += chalk.gray('─'.repeat(80));
  return output;
}

function rescheduleMissedAlarm(m) {
  // Create a new alarm entry for tomorrow (handles DST in wall-clock time)
  if (m.type === 'at' && m.when) {
    const match = m.when.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return false;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    
    // Calculate tomorrow's occurrence using wall-clock time (handles DST)
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(hour, minute, 0, 0);
    
    // Validate tomorrow is actually in the future (prevent clock adjustment issues)
    if (tomorrow.getTime() <= Date.now()) return false;
    
    const delay = msUntil(tomorrow);
    if (delay > MAX_SETTIMEOUT_DELAY || delay < 0) return false;
    
    // Clear old timeout for this missed alarm BEFORE creating new alarm
    const oldTimeout = pendingTimeouts.get(`alarm_${m.id}`);
    if (oldTimeout) {
      clearTimeout(oldTimeout);
      pendingTimeouts.delete(`alarm_${m.id}`);
    }
    
    const entry = addPending('at', m.when, m.label, tomorrow);
    if (entry) {
      const timeoutId = setTimeout(() => {
        try {
          playAlarm(m.label);
        } finally {
          removePending(entry.id);
          pendingTimeouts.delete(`alarm_${entry.id}`);
        }
      }, delay);
      pendingTimeouts.set(`alarm_${entry.id}`, timeoutId);
      return true;
    }
    return false;
  }
  if (m.type === 'in' && m.fireTime) {
    // CRITICAL FIX: For 'in' alarms, calculate using 24 hours of wall-clock time (handles DST)
    if (!Number.isFinite(m.fireTime)) return false;
    
    // Use wall-clock time arithmetic: same time tomorrow
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(today.getHours(), today.getMinutes(), today.getSeconds(), today.getMilliseconds());
    
    // Validate tomorrow is actually in the future (prevent clock adjustment issues)
    if (tomorrow.getTime() <= Date.now()) return false;
    
    const delayMs = tomorrow.getTime() - Date.now();
    const mins = delayMs / (60 * 1000);
    if (mins <= 0.1 || delayMs > MAX_SETTIMEOUT_DELAY) return false;
    
    // Clear old timeout for this missed alarm BEFORE creating new alarm
    const oldTimeout = pendingTimeouts.get(`alarm_${m.id}`);
    if (oldTimeout) {
      clearTimeout(oldTimeout);
      pendingTimeouts.delete(`alarm_${m.id}`);
    }
    
    const entry = addPending('in', `${mins.toFixed(2)}m`, m.label, tomorrow);
    if (entry) {
      scheduleIn(mins, m.label, entry.id);
      return true;
    }
  }
  return false;
}

function solveMissedInteractive() {
  if (missedAlarms.length === 0) {
    log(chalk.green('No missed alarms.'));
    return;
  }

  const output = listMissedAlarms();
  refreshDisplay(output);
  rl.question(chalk.yellow('Enter command (reschedule <id> | reschedule all | drop <id> | drop all): '), (answer) => {
    const parts = answer.trim().split(/\s+/);
    const action = (parts[0] || '').toLowerCase();
    const arg = parts[1];
    const reshow = () => solveMissedInteractive();

    if (action === 'reschedule') {
      if (!arg) {
        log(chalk.yellow('Usage: reschedule <id> | reschedule all'));
        return reshow();
      }

      if (arg.toLowerCase() === 'all') {
        let success = 0;
        const toProcess = [...missedAlarms];
        missedAlarms.length = 0;
        toProcess.forEach(m => {
          if (rescheduleMissedAlarm(m)) {
            success++;
          } else {
            missedAlarms.push(m);
          }
        });
        savePending();
        log(chalk.green(`Rescheduled ${success} alarm(s). Remaining missed: ${missedAlarms.length}.`));
        return reshow();
      }

      const id = Number(arg);
      const idx = missedAlarms.findIndex(m => m.id === id);
      if (idx === -1) {
        log(chalk.red('wrong id'));
        return reshow();
      }
      const m = missedAlarms[idx];
      const ok = rescheduleMissedAlarm(m);
      if (ok) {
        missedAlarms.splice(idx, 1);
        savePending();
        log(chalk.green('Alarm rescheduled for next day.'));
      } else {
        log(chalk.red('Could not reschedule alarm.'));
      }
      return reshow();
    }

    if (action === 'drop') {
      if (!arg) {
        log(chalk.yellow('Usage: drop <id> | drop all'));
        return reshow();
      }

      if (arg.toLowerCase() === 'all') {
        missedAlarms.length = 0;
        savePending();
        log(chalk.green('All missed alarms dropped.'));
        return reshow();
      }

      const id = Number(arg);
      const idx = missedAlarms.findIndex(m => m.id === id);
      if (idx === -1) {
        log(chalk.red('wrong id'));
        return reshow();
      }
      missedAlarms.splice(idx, 1);
      savePending();
      log(chalk.green('Alarm dropped.'));
      return reshow();
    }

    log(chalk.red('Unknown solve command. Expected: reschedule <id> | reschedule all | drop <id> | drop all'));
    return reshow();
  });
}
