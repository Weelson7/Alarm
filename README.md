# Alarm Scheduler

A Windows-based alarm scheduler built with Node.js. Schedule alarms at specific times or after a set duration, set daily recurring alarms, adjust volume, and rely on persistent state with automatic crash recovery.

## Quick Start

1. Install Node.js (LTS recommended).
2. Place an audio file named `alarm.mp3` in this folder.
3. Install dependencies:

```bash
npm install
```

4. Start with the watchdog (recommended on Windows):

```bash
cscript watchdog.vbs
```

Or start directly:

```bash
npm start
```

To stop cleanly, type `exit` or `quit` in the app. This writes a `stop.flag` so the watchdog won’t restart it.

## Features

- **Schedule at time**: `at HH:MM [label]` — 24h format; runs tomorrow if time has passed.
- **Schedule in minutes**: `in <0.1–1440> [label]` — decimals allowed.
- **Daily alarms**: Add, modify, delete recurring alarms; auto-reset enabled state at midnight.
- **Volume control**: `vol [0–100]`; persists across restarts.
- **Missed alarms handling**: Interactive tools to reschedule or drop missed alarms.
- **Persistent state**: Alarms and settings saved to disk with atomic writes and backups.
- **Crash recovery**: `run.bat` restarts on crashes; `watchdog.vbs` supervises and avoids loops.
- **Wake from sleep**: Automatically creates Windows Scheduled Tasks to wake the PC 30 seconds before each manual and daily alarm (best-effort).

## Commands

Run the app and type commands at the `->` prompt:

- `in <minutes> [label]`: alarm after N minutes (0.1–1440).
- `at <HH:MM> [label]`: alarm at 24h clock time (tomorrow if passed).
- `stop the alarm`: stop currently playing alarm.
- `vol [0–100]`: show or set alarm volume.
- `daily add <HH:MM> <label>`: add a daily recurring alarm.
- `daily modify`: interactively modify a daily alarm.
- `daily delete`: interactively delete a daily alarm.
- `disable daily` / `enable daily`: toggle daily alarms for today (auto-resets at midnight).
- `list`: show scheduled daily and manual alarms.
- `remove`: interactively remove a manual alarm by ID.
- `status`: show scheduler status and daily alarm state.
- `clear pending`: clear all pending manual alarms.
- `solve missed`: manage missed alarms (reschedule/drop individually or all).
- `help`: show help.
- `quit` / `exit`: stop the scheduler gracefully.

## Files & State

- `scheduler.js`: main application.
- `run.bat`: restart-on-crash supervisor (up to 5 retries; resets after stable run).
- `watchdog.vbs`: external watchdog that starts `run.bat`, monitors `heartbeat.txt`, and stops when `stop.flag` exists.
- `package.json`: metadata and `npm start` script.
- `alarm.mp3`: audio file played for alarms (you must provide this).

State and logs:

- `config.json`: volume, ID counters, daily alarm toggle, last reset date.
- `pending.json`: manual, daily, and missed alarms (auto-backup to `pending.json.bak`).
- `heartbeat.txt`: written every 3s to indicate the app is alive.
- `restart_count.txt`: watchdog keeps a crash restart counter here.
- `stop.flag`: written on `quit/exit` to signal graceful shutdown.

## Requirements

- Windows 10/11
- Node.js 14+ (tested) and PowerShell
- Administrator privileges recommended for reliable audio control
- Allow wake timers in Windows Power Options

## Error Recovery

- `run.bat` restarts on non-zero exit or unexpected clean exit (without `stop.flag`).
- Retry counter resets if the app stays up for 5+ minutes.
- `watchdog.vbs` limits restarts and resets after stability; exits when `stop.flag` is present.
- Pending and daily alarms are restored on restart. Corrupted files auto-restore from backups when possible.

## Troubleshooting

- App won’t start: ensure Node.js is installed and `npm install` succeeded; try `cscript watchdog.vbs`.
- No sound: verify `alarm.mp3` exists; check system volume; ensure `vol` is not `0`.
- Daily alarms not firing: confirm daily is enabled (`enable daily`), system time is correct, then restart.
- PC doesn’t wake: ensure wake timers are allowed and task wake is set.
	- Power Options → Advanced settings → Sleep → Allow wake timers → Enable.
	- Task Scheduler tasks are named `StudyAlarmWake_alarm_<id>` and `StudyAlarmWake_daily_<id>`; verify their triggers.
	- Some Modern Standby devices restrict waking on battery; try on AC power.

## License
## Sleep/Wake Notes

This app attempts to wake the machine 30 seconds before alarms by registering Windows Scheduled Tasks via PowerShell:

- Manual alarms (`in`/`at`): one-time tasks created at the computed time minus 30 seconds.
- Daily alarms: a persistent daily task created at the alarm time minus 30 seconds.

Wake is best-effort and depends on system policy. If tasks fail to register due to permissions or policy, you can manually create wake-enabled tasks in Task Scheduler to run shortly before your alarms (any trivial action is fine). Make sure wake timers are enabled in Power Options.

Personal use only; no warranty.
