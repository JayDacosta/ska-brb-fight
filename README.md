# Ska BRB Fight

A cheap hosted Twitch chat fighting overlay for OBS.

Viewers type chat commands like `!fight`, `!strike`, `!jump`, and `!weapon`. The hosted app reads Twitch chat, forwards commands to the overlay through WebSockets, and the OBS Browser Source displays the fight.

## What this version does

- OBS overlay route: `/overlay`
- Admin test panel: `/admin`
- Twitch chat listener over Twitch IRC WebSocket
- Supports authenticated bot token or anonymous read-only mode
- Chat commands:
  - `!fight` or `!join`
  - `!strike` or `!punch`
  - `!jump`
  - `!dash`
  - `!block`
  - `!weapon`
  - `!special`
  - `!taunt`
- Canvas fighting arena
- HP bars
- KOs
- Coins
- Survival coins
- Coin stealing on KO
- Leaderboard
- Match results screen

## Local dev

```bash
npm install
cp .env.example .env
npm run dev
```

Open:

```text
http://localhost:3000/overlay
http://localhost:3000/admin
```

## Environment variables

```text
TWITCH_CHANNEL=skavstheworld
ADMIN_KEY=make-this-random
OVERLAY_KEY=
TWITCH_BOT_USERNAME=
TWITCH_OAUTH_TOKEN=
MATCH_SECONDS=300
COIN_HIT=2
COIN_SURVIVE=1
COIN_KO_BONUS=12
```

### Twitch token note

Official Twitch IRC docs say authenticated IRC connections require a User Access Token with `chat:read`, and `chat:edit` is needed if the bot sends messages. This app only reads chat, so `chat:read` is enough for the authenticated setup.

The app also has anonymous read-only mode if `TWITCH_BOT_USERNAME` and `TWITCH_OAUTH_TOKEN` are blank. That keeps the MVP cheap and simple, but the official/reliable setup is a bot account with a real token.

## Cheapest deployment path: Render

1. Create a GitHub repo.
2. Upload this folder.
3. Go to Render.
4. New Web Service.
5. Connect the repo.
6. Use:

```text
Build Command: npm install
Start Command: npm start
Node Version: 20+
```

7. Add environment variables:

```text
TWITCH_CHANNEL=skavstheworld
ADMIN_KEY=your-random-admin-key
```

Optional:

```text
OVERLAY_KEY=your-random-overlay-key
TWITCH_BOT_USERNAME=yourbotname
TWITCH_OAUTH_TOKEN=oauth:your-token
```

8. Deploy.

OBS URL:

```text
https://your-render-app.onrender.com/overlay
```

If you set `OVERLAY_KEY`, use:

```text
https://your-render-app.onrender.com/overlay?key=your-random-overlay-key
```

## OBS setup

Add a Browser Source:

```text
URL: https://your-render-app.onrender.com/overlay
Width: 1920
Height: 1080
Refresh browser when scene becomes active: enabled
Shutdown source when not visible: enabled
```

## Admin test panel

Open:

```text
https://your-render-app.onrender.com/admin
```

Enter your `ADMIN_KEY`, open the overlay in another tab, and test the buttons.

## Lumia later

Lumia can later call this endpoint:

```text
POST /api/command
```

Payload:

```json
{
  "key": "your-admin-key",
  "username": "ViewerName",
  "command": "fight"
}
```

But for this version, Twitch chat is already connected directly.

## Important limits

This MVP stores match state inside the OBS overlay page. If the overlay reloads, the match resets.

It does not persist coins to a database yet. For real long-term loyalty/reward points, add a free database such as Supabase, Neon, or Turso later, or bridge payout results into Lumia.
