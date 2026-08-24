# Notification Type-Based Sounds Guide

## Overview
The notification bubble now supports different sounds for different types of notifications. Each notification type can be assigned its own unique ringtone.

## Supported Notification Types

The app expects your notifications to include a type field with one of these values:

1. **available** - "Available to accept" notifications
2. **accepted** - "Accepted" notifications  
3. **reply** - "New reply" notifications
4. **status** - "Status Changed / Closed" notifications

## How It Works

### Expected Notification Data Structure
Your notification data from the server should include a type field:

```json
{
  "id": "12345",
  "title": "New Ticket",
  "message": "A new ticket is available",
  "type": "available",
  "is_read": false,
  "created_at": "2024-01-15 10:30:00",
  "open_url": "https://..."
}
```

### Possible Field Names
The app checks for the notification type in the following order:
1. `type`
2. `action`
3. `category`
4. `kind`
5. `notif_type`
6. `notification_type`

If your server uses a different field name, you can modify the `getRingtoneForNotification()` function in bubble.html.

## Configuration

### In Settings:
1. Open the notification bubble and click the gear icon (⚙️) to access Settings
2. Scroll to the **"🎵 Sound Per Notification Type"** section
3. For each notification type (Available to accept, Accepted, New reply, Status Changed), select your preferred sound
4. Click the play button (▶️) next to each dropdown to preview the sound
5. Settings are automatically saved

### Available Sounds:
- Soft Ding
- Chime Bell
- Pulse Beep
- Marimba Hit
- Alert Tone
- Cuckoo Clock
- Siren Wail
- Piano Arpeggio
- Church Bell
- Morse Beep
- Xylophone
- Fanfare
- Referee Whistle

## Default Sound Mappings
When you first use the app, the following defaults are set:

| Notification Type | Default Sound |
|-------------------|---------------|
| Available to accept | Fanfare |
| Accepted | Chime Bell |
| New reply | Pulse Beep |
| Status Changed | Marimba Hit |

## Troubleshooting

### Sounds not changing by type
- Ensure your server is sending notifications with one of the type field names listed above
- Check the browser console (F12 → Console tab) for any errors
- Verify the type values match: `available`, `accepted`, `reply`, `status`

### To test the type-specific sounds
1. Go to Settings and click the play button next to each notification type
2. You should hear the different sounds you configured

### How to modify field name detection
If your server uses a custom field name for notification type, edit the `getRingtoneForNotification()` function in bubble.html and add your field name to the list of checked properties.

## Example Modification
If your server sends notifications with a `notification_action` field:

Find this line in bubble.html:
```javascript
const notifType = notifItem.type || notifItem.action || notifItem.category || notifItem.kind || notifItem.notif_type || notifItem.notification_type;
```

Modify it to include your custom field:
```javascript
const notifType = notifItem.notification_action || notifItem.type || notifItem.action || notifItem.category || notifItem.kind || notifItem.notif_type || notifItem.notification_type;
```

## Notes
- When multiple notifications arrive at once, each plays its type-specific sound
- In Alarm Mode (ringtone toggle ON), the type-specific sound repeats at the interval you set
- In Normal Mode (ringtone toggle OFF), each new notification type plays once
- All settings are saved to your browser's local storage
