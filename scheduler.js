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
let alarmProcess = null;
let dailyAlarmsEnabledToday = true;
let alarmVolume = 100;
let lastResetDate = new Date().toDateString();
const pendingTimeouts = new Map(); // Track setTimeout IDs for cleanup
let config = { volume: 100 }; // Config to persist volume

// Daily alarms are now stored dynamically
let dailyAlarms = [];
let dailyAlarmIdCounter = 0;

function nextDailyAlarmId() {
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
  const author = chalk.gray('                           by Weelson');
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
  // If target is in the past, schedule for tomorrow
  // Note: DST transitions may cause 1-hour shifts in alarm times
  if (target < now) {
    target.setDate(target.getDate() + 1);
  }
  return target;
}

function scheduleAt(timeStr, label, alarmId) {
  const match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    log(chalk.red('Time must be HH:MM in 24h format.'));
    return;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    log(chalk.red('Time must be HH:MM in 24h format.'));
    return;
  }

  const fireTime = nextOccurrence(hour, minute);
  const delay = msUntil(fireTime);
  
  // Protect against setTimeout 32-bit overflow (max ~24.8 days)
  if (delay > 2147483647) {
    log(chalk.red('Time is too far in the future (>24.8 days). Please try again closer to the time.'));
    return;
  }
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
  
  // Register timeout immediately using provided alarmId to avoid race condition
  if (alarmId) {
    pendingTimeouts.set(`alarm_${alarmId}`, timeoutId);
  }
  log(chalk.green(`Scheduled for ${chalk.cyan(fireTime.toLocaleString())}${label ? ` (${chalk.yellow(label)})` : ''}.`));
}

function scheduleIn(minutes, label, alarmId) {
  const mins = Number(minutes);
  if (!Number.isFinite(mins) || mins < 0.1 || mins > 1440) {
    log(chalk.red('Minutes must be a positive number between 0.1 and 1440.'));
    return;
  }
  
  // Allow fractional minutes (minimum 0.1 = 6 seconds for user reaction time)
  const delayMs = Math.round(mins * 60 * 1000);
  
  // Protect against setTimeout 32-bit overflow (max ~24.8 days)
  if (delayMs > 2147483647) {
    log(chalk.red('Delay exceeds maximum allowed (24.8 days). Please use a smaller value.'));
    return;
  }
  
  const fireTime = new Date(Date.now() + delayMs);
  
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
  
  // Register timeout immediately using provided alarmId to avoid race condition
  if (alarmId) {
    pendingTimeouts.set(`alarm_${alarmId}`, timeoutId);
  }
  log(chalk.green(`Scheduled in ${chalk.cyan(mins)} minute(s) at ${chalk.cyan(fireTime.toLocaleString())}${label ? ` (${chalk.yellow(label)})` : ''}.`));
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
  function scheduleNext() {
    const fireTime = nextOccurrence(hour, minute);
    const delay = msUntil(fireTime);
    const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    
    // Store timeout but allow it to be overwritten each day
    const timeoutId = setTimeout(() => {
      try {
        if (dailyAlarmsEnabledToday) {
          playAlarm(`Daily: ${label || timeStr}`);
        }
      } finally {
        // Always reschedule, even if playAlarm fails
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
function startHeartbeat() {
  const writeBeat = () => {
    try {
      fs.writeFileSync(heartbeatFile, `${Date.now()}`);
      heartbeatFailures = 0; // Reset on success
    } catch (err) {
      heartbeatFailures++;
      if (heartbeatFailures >= 3) {
        console.log(chalk.yellow(`Warning: Heartbeat write failed ${heartbeatFailures} times: ${err.message}`));
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
      alarmVolume = Math.min(100, Math.max(0, Number(loadedVol) || 100));
      alarmIdCounter = config.alarmIdCounter ?? 0; // Restore counter to prevent ID collisions
      dailyAlarmIdCounter = config.dailyAlarmIdCounter ?? 0; // Restore daily alarm counter
      lastResetDate = config.lastResetDate ?? new Date().toDateString(); // Restore last reset date
      dailyAlarmsEnabledToday = config.dailyAlarmsEnabledToday ?? true; // Restore daily alarms state
      // Silent load - only log errors
    }
  } catch (err) {
    console.log(chalk.yellow(`Warning: Could not load config.json: ${err.message}`));
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
    
    config.volume = volumeToSave;
    config.alarmIdCounter = alarmIdCounter; // Persist counter
    config.dailyAlarmIdCounter = dailyAlarmIdCounter; // Persist daily alarm counter
    config.lastResetDate = lastResetDate; // Persist last reset date
    config.dailyAlarmsEnabledToday = dailyAlarmsEnabledToday; // Persist daily alarms state
    fs.writeFileSync('config.json', JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.log(chalk.yellow(`Warning: Could not save config.json: ${err.message}`));
  }
}

function savePending() {
  try {
    // Validate data structure before saving
    if (!Array.isArray(pending) || !Array.isArray(dailyAlarms)) {
      console.log(chalk.yellow('Warning: Invalid data structure, skipping save.'));
      return;
    }
    
    // Validate individual alarm objects
    const validPending = pending.filter(p => p.id && p.type && (p.type === 'in' || p.type === 'at'));
    const validDaily = dailyAlarms.filter(d => d.id && typeof d.hour === 'number' && typeof d.minute === 'number');
    
    if (validPending.length !== pending.length || validDaily.length !== dailyAlarms.length) {
      console.log(chalk.yellow(`Warning: Filtered out ${pending.length - validPending.length} invalid manual and ${dailyAlarms.length - validDaily.length} invalid daily alarms.`));
    }
    
    // Backup before overwrite to prevent corruption
    if (fs.existsSync('pending.json')) {
      fs.copyFileSync('pending.json', 'pending.json.bak');
    }
    const data = {
      manual: validPending,
      daily: validDaily
    };
    fs.writeFileSync('pending.json', JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.log(chalk.yellow(`Warning: Could not save pending.json: ${err.message}`));
    // Try to restore from backup if save failed
    try {
      if (fs.existsSync('pending.json.bak')) {
        fs.copyFileSync('pending.json.bak', 'pending.json');
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
      
      // Handle both old format (array) and new format (object with manual/daily)
      const manualAlarms = Array.isArray(loaded) ? loaded : (loaded.manual || []);
      const loadedDailyAlarms = Array.isArray(loaded) ? [] : (loaded.daily || []);
      
      // Load daily alarms
      dailyAlarms = loadedDailyAlarms;
      if (dailyAlarms.length === 0) {
        // First time using new format, add default daily alarms
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
      } else if (dailyAlarms.length > 0) {
        // Restore counter from loaded alarms
        let maxDailyId = dailyAlarmIdCounter;
        dailyAlarms.forEach(d => {
          if (d.id > maxDailyId) maxDailyId = d.id;
        });
        dailyAlarmIdCounter = maxDailyId;
      }
      
      // Restore manual pending alarms and reschedule
      let missedCount = 0;
      const MAX_MISSED_TO_PLAY = 3;
      
      manualAlarms.forEach(p => {
        if (p.type === 'in' && p.fireTime) {
          if (p.fireTime <= now) {
            // Limit missed alarms to prevent flooding
            if (missedCount < MAX_MISSED_TO_PLAY) {
              playAlarm(`Missed: ${p.label || 'alarm'}`);
              missedCount++;
            }
            // Don't add to pending list - it's expired
          } else {
            // Reschedule future 'in' alarms
            const delay = p.fireTime - now;
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
          let fireTime = nextOccurrence(hour, minute);
          
          // Play missed alarms immediately for consistency (with limit)
          if (fireTime.getTime() <= now) {
            if (missedCount < MAX_MISSED_TO_PLAY) {
              playAlarm(`Missed: ${p.label || 'alarm'}`);
              missedCount++;
            }
          } else {
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
      
        // Notify about skipped missed alarms
        const totalMissed = manualAlarms.filter(p => {
          if (p.type === 'in' && p.fireTime && p.fireTime <= now) return true;
          if (p.type === 'at' && p.when) {
            const [hour, minute] = p.when.split(':').map(Number);
            const fireTime = nextOccurrence(hour, minute);
            if (fireTime.getTime() <= now) return true;
          }
          return false;
        }).length;
      
        if (totalMissed > MAX_MISSED_TO_PLAY) {
          console.log(chalk.yellow(`Note: ${totalMissed - MAX_MISSED_TO_PLAY} additional missed alarm(s) were skipped.`));
          console.log();
        }
      
        // Update alarmIdCounter to prevent ID collisions (use max of config or loaded IDs)
      let maxIdLoaded = alarmIdCounter;
      manualAlarms.forEach(p => {
        if (p.id > maxIdLoaded) maxIdLoaded = p.id;
      });
      alarmIdCounter = Math.max(alarmIdCounter, maxIdLoaded);
      
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
        fs.copyFileSync('pending.json.bak', 'pending.json');
        console.log(chalk.green('Restored from backup.'));
      }
    } catch (e) {
      console.log(chalk.yellow(`Warning: Could not restore from backup: ${e.message}`));
    }
  }
}

function addPending(type, when, label, fireTime = null) {
  // Prevent duplicate 'at' alarms, limit 'in' duplicates to 2
  if (type === 'at') {
    const exists = pending.some(p => p.type === type && p.when === when && (p.label || '') === (label || ''));
    if (exists) {
      log(chalk.yellow('This alarm is already scheduled.'));
      return null;
    }
  } else if (type === 'in') {
    // Count identical 'in' alarms by comparing fireTime (within 5 second tolerance)
    const count = pending.filter(p => {
      if (p.type !== 'in' || !p.fireTime || !fireTime) return false;
      const timeDiff = Math.abs(p.fireTime - fireTime.getTime());
      return timeDiff < 5000 && (p.label || '') === (label || '');
    }).length;
    if (count >= 2) {
      log(chalk.yellow(`Maximum 2 identical alarms allowed. You have ${count} already.`));
      return null;
    }
  }
  
  const entry = { id: nextAlarmId(), type, when, label };
  if (fireTime) {
    entry.fireTime = fireTime.getTime();
  }
  pending.push(entry);
  saveConfig(); // Save config to persist alarmIdCounter
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
  
  // Filter out fired alarms before displaying
  const activePending = pending.filter((p) => {
    // For 'in' alarms, check fireTime directly
    if (p.type === 'in' && p.fireTime && p.fireTime <= now) {
      return false;
    }
    // For 'at' alarms, recalculate fireTime to check if it's in the past
    if (p.type === 'at' && p.when) {
      const match = p.when.match(/^(\d{1,2}):(\d{2})$/);
      if (match) {
        const hour = Number(match[1]);
        const minute = Number(match[2]);
        const fireTime = nextOccurrence(hour, minute);
        if (fireTime.getTime() <= now) {
          return false;
        }
      }
    }
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
      // Parse time and calculate fireTime
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
        log(chalk.red('Time must be HH:MM in 24h format.'));
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
          log(chalk.red('Time must be HH:MM in 24h format.'));
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
        rl.question(chalk.yellow('Enter ID to modify: '), (idInput) => {
          const id = Number(idInput.trim());
          const alarmToModify = dailyAlarms.find(a => a.id === id);
          
          if (!alarmToModify) {
            log(chalk.red('Wrong ID'));
            return;
          }
          
          // Prompt for new time
          rl.question(chalk.yellow(`New time (HH:MM) [${String(alarmToModify.hour).padStart(2, '0')}:${String(alarmToModify.minute).padStart(2, '0')}]: `), (timeInput) => {
            const timeTrimmed = timeInput.trim();
            let newHour = alarmToModify.hour;
            let newMinute = alarmToModify.minute;
            
            if (timeTrimmed) {
              const match = timeTrimmed.match(/^(\d{1,2}):(\d{2})$/);
              if (!match || Number(match[1]) < 0 || Number(match[1]) > 23 || Number(match[2]) < 0 || Number(match[2]) > 59) {
                log(chalk.red('Invalid time format. Changes cancelled.'));
                return;
              }
              newHour = Number(match[1]);
              newMinute = Number(match[2]);
              
              // Check for duplicate with other alarms (excluding current one)
              const duplicate = dailyAlarms.find(a => a.id !== id && a.hour === newHour && a.minute === newMinute);
              if (duplicate) {
                log(chalk.red(`Another daily alarm already exists at ${timeTrimmed}${duplicate.label ? ` (${duplicate.label})` : ''}. Changes cancelled.`));
                return;
              }
            }
            
            // Prompt for new label
            rl.question(chalk.yellow(`New label [${alarmToModify.label || '-'}]: `), (labelInput) => {
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
              } catch (err) {
                // Rollback on error
                alarmToModify.hour = oldHour;
                alarmToModify.minute = oldMinute;
                alarmToModify.label = oldLabel;
                dailyAlarms.sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
                log(chalk.red(`Failed to modify alarm: ${err.message}. Changes reverted.`));
              }
            });
          });
        });
        return; // Don't continue switch, waiting for async prompts
      }
      
      if (subCmd === 'delete') {
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
      });
      return; // Don't continue switch, waiting for async prompt
    }
    case 'clear':
      if (rest[0] && rest[0].toLowerCase() === 'pending') {
        if (pending.length === 0) {
          log(chalk.yellow('No pending alarms to clear.'));
          break;
        }
        
        // Ask for confirmation
        const pendingCount = pending.length;
        refreshDisplay(`${chalk.yellow.bold('Warning:')} This will clear ${pendingCount} pending alarm(s).`);
        rl.question(chalk.yellow('Type YES to confirm: '), (confirmation) => {
          if (confirmation.trim().toUpperCase() === 'YES') {
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
            log(chalk.green('Pending alarms cleared.'));
          } else {
            log(chalk.cyan('Cancelled.'));
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
      if (!Number.isFinite(vol) || vol < 0 || vol > 100) {
        log(chalk.red('Volume must be a number between 0 and 100.'));
      } else {
        alarmVolume = vol;
        saveConfig();
        log(chalk.green(`Alarm volume set to `) + chalk.yellow(`${vol}%`) + chalk.green('.'));
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

rl.on('line', handle);
rl.on('close', () => process.exit(process.exitCode || 0));

process.on('uncaughtException', (err) => {
  console.log(chalk.red.bold(`Fatal error: ${err.message}`));
  process.exit(1);
});
