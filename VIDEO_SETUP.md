# Video calls (Twilio)

## "The authorization with Token failed"

This almost always comes from **using the wrong Twilio credentials** for the video token.

### Use an API Key, not Auth Token

- **`TWILIO_API_KEY_SID`** must be the **API Key SID** (starts with **`SK`**).
- **`TWILIO_API_KEY_SECRET`** must be the **API Key Secret** (the secret for that key).

Do **not** use:

- Your **Account SID** (starts with `AC`) in `TWILIO_API_KEY_SID`.
- Your **Auth Token** (from "API keys & tokens" → Auth Token) in `TWILIO_API_KEY_SECRET`.

### How to get the right values

1. In [Twilio Console](https://console.twilio.com) go to **Account** (top right) → **API keys & tokens**.
2. Under **API keys**, click **Create API key**.
3. Give it a name (e.g. "Video calls"), leave **Standard** or **Main**.
4. **Region**: choose **United States (US1)**. Video tokens must use a US1 key.
5. Click **Create**.
6. Copy the **SID** (starts with `SK`) → put it in `TWILIO_API_KEY_SID`.
7. Copy the **Secret** (shown only once) → put it in `TWILIO_API_KEY_SECRET`.

Keep **`TWILIO_ACCOUNT_SID`** as your main Account SID (starts with `AC`). Only the key SID and key Secret go into `TWILIO_API_KEY_SID` and `TWILIO_API_KEY_SECRET`.

### Checklist

- [ ] `TWILIO_ACCOUNT_SID` = Account SID (`AC...`)
- [ ] `TWILIO_API_KEY_SID` = API Key SID (`SK...`), **not** Account SID
- [ ] `TWILIO_API_KEY_SECRET` = API Key Secret for that key, **not** the main Auth Token
- [ ] API Key was created in **US1** region
- [ ] No extra spaces or quotes around values in `.env`
- [ ] Backend restarted after changing `.env`
