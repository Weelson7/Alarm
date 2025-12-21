# Alarm Scheduler

A Windows-based alarm scheduler application built with Node.js. Schedule alarms at specific times or after a set duration, with daily recurring alarms and persistent state management.

## Features

- **Schedule alarms at specific times** - Use 24-hour format (HH:MM)
- **Schedule alarms after a duration** - Set alarms for minutes from now (max 1440 minutes/24 hours)
- **Daily recurring alarms** - Set up to 16 daily alarms that repeat every day
- **Volume control** - Adjust alarm volume from 0-100%
- **Persistent state** - Alarms persist across application restarts
- **Automatic restart** - Watchdog supervisor restarts the scheduler on crashes
- **Admin elevation** - VBScript launcher handles Windows UAC elevation

## Installation

1. Install [Node.js](https://nodejs.org/) (LTS version recommended)
2. Clone or download this repository
3. Navigate to the project directory
4. Install dependencies:
   ```
   npm install
   ```

## Usage

### Starting the Scheduler

Run the watchdog to start the scheduler with admin elevation:
```
cscript watchdog.vbs
```

Or directly start with Node.js:
```
npm start
```

### Commands

Once running, the scheduler accepts the following commands:

#### Schedule an alarm at a specific time
```
at 14:30 Lunch reminder
```
Schedules an alarm at 14:30 (2:30 PM) with label "Lunch reminder"

#### Schedule an alarm after N minutes
```
in 30 Wake up
```
Schedules an alarm in 30 minutes with label "Wake up"

#### Add a daily recurring alarm
```
daily 08:00 Morning alarm
```
Adds a daily alarm at 08:00 every day

#### Remove a daily alarm
```
remove-daily 08:00
```
Removes the daily alarm at 08:00

#### Show pending alarms
```
show
```
Displays all scheduled alarms with their fire times

#### Clear all alarms
```
clear
```
Removes all pending alarms (daily alarms remain)

#### Set alarm volume
```
volume 75
```
Sets alarm volume to 75% (0-100)

#### Exit
```
exit
```
Gracefully shuts down the scheduler

## Configuration

The scheduler stores state in JSON files:

- `config.json` - Alarm volume, alarm ID counter, last reset date, daily alarms enabled status
- `pending.json` - Pending alarms awaiting trigger

These files are created automatically and include backup recovery (.bak files) in case of corruption.

## Files

- `scheduler.js` - Main scheduler application (Node.js)
- `run.bat` - Batch supervisor script with restart logic
- `watchdog.vbs` - VBScript launcher for admin elevation
- `package.json` - Node.js dependencies and metadata
- `alarm.mp3` - Audio file played when alarm triggers

## Requirements

- Windows operating system
- Node.js 14.0 or later
- PowerShell (included with Windows)
- Administrator privileges (for audio control)

## Error Recovery

If the application crashes:
1. `run.bat` automatically restarts it (up to 5 consecutive attempts)
2. If 5 crashes occur in quick succession, the batch file exits with an error
3. Pending alarms are restored from `pending.json` on restart
4. If state files are corrupted, backups (.bak files) are automatically used

## Troubleshooting

### Application won't start
- Ensure Node.js is installed and in your PATH
- Run `watchdog.vbs` with administrator privileges
- Check that all files are in the same directory

### Alarms not playing
- Verify `alarm.mp3` exists in the application directory
- Check Windows volume is not muted
- Ensure the volume percentage is not set to 0%

### Daily alarms not triggering
- Check that daily alarms are enabled (add one with `daily HH:MM Label`)
- Verify the system time is correct
- Restart the application

## License

This project is provided as-is for personal use.
