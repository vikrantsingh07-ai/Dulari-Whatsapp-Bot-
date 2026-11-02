# Easy setup (about 45 minutes, all free)

You do **Part 1** by clicking around websites and **Part 2** with one command. The command asks you simple questions and does the technical work.

## Part 1: Get these 6 things ready

Keep a notepad open and paste each item there as you go.

**1. Cloudflare account** (free): sign up at dash.cloudflare.com. Nothing else to do.

**2. Supabase database** (free)
- supabase.com -> New project -> region **Mumbai** -> choose a database password and save it.
- Click **Connect** (top bar) -> **Session pooler** -> copy the link.

**3. AI key.** Pick one:
- **OpenRouter** (openrouter.ai -> Keys -> Create key). One key for many models. Pick a model on openrouter.ai/models that supports **tool calling** (filter by "tools"). The setup uses `openrouter/free` if you don't choose, which lets OpenRouter pick any free model that can use tools.
- **Anthropic** (console.anthropic.com -> API keys). Set a monthly spend limit in Settings -> Limits.

**4. Telegram**
- In Telegram, message **@BotFather**, send `/newbot`, follow the questions, save the **token**.
- Create a group called **Dulari Leads**, add your new bot and Akash.

**5. Google sheets**
- Create two Google Sheets: **Dulari Bot Brain** (tabs: `Products`, `FAQ`, `Policies`, `Settings`, `Team`) and **Dulari Leads**. Column names are in the README.
- In Settings add two rows: `SHADOW_MODE` = `TRUE` and `BOT_ENABLED` = `TRUE`.
- console.cloud.google.com -> new project -> enable **Google Sheets API** -> Credentials -> Create **service account** -> Keys -> Add key -> JSON (it downloads a file).
- Open the service account, copy its email address. Share the Brain sheet with that email as **Viewer** and the Leads sheet as **Editor**.

**6. Meta WhatsApp test number** (free)
- developers.facebook.com -> Create app -> type **Business** -> add **WhatsApp**.
- Copy the **Phone number ID** and, from App settings -> Basic, the **App secret**.
- Get an access token that doesn't expire: Business Settings -> Users -> System users -> Add -> assign the WhatsApp account -> Generate token with `whatsapp_business_messaging` and `whatsapp_business_management`.

## Part 2: Run the setup

On your computer (needs Node 20 or newer, from nodejs.org):

```bash
git clone -b claude/dazzling-johnson-nplgxu https://github.com/vikrantsingh07-ai/Dulari-Whatsapp-Bot-.git && cd Dulari-Whatsapp-Bot- && npm install && npm run setup
```

It will:
1. open a browser to log in to Cloudflare
2. ask for the Supabase link and create the database tables
3. ask for your keys (typing is hidden) and find your Telegram group by itself
4. put the bot online and store the keys safely
5. connect Telegram
6. tell you what to paste into Meta

## Part 3: Tell Meta where the bot is (the setup prints these two values)

Meta app -> WhatsApp -> Configuration -> Webhook -> Edit:
- **Callback URL**: the address the setup printed, ending in `/webhook`
- **Verify token**: the token the setup printed

Click Verify and save. Under Webhook fields, tick **messages**.

## Test

Send your test number a WhatsApp message like "Hi, I would like to inquire about: Daily Table". Shadow mode is on, so the reply appears as a **Draft** in your Telegram group with 👍 / 👎 buttons. Nothing reaches the customer yet. That is correct.

When the drafts look good (the spec wants 90% 👍 over 50 drafts), set `SHADOW_MODE` to `FALSE` in the Settings tab.

## If something goes wrong

Run `npm run setup` again: it skips what is already done. If it says "not healthy", the usual cause is that the Brain sheet isn't shared with the service account email, or a tab name is spelled differently.

## Brain sheet in 2 minutes (use the ready-made file)

1. Download `docs/brain-template.xlsx` from this project (it is already in your `Dulari-Whatsapp-Bot-` folder, in the `docs` folder).
2. Go to **drive.google.com** -> **New** -> **File upload** -> pick `brain-template.xlsx`.
3. Open the uploaded file, then **File -> Save as Google Sheets**. Rename it **Dulari Bot Brain**.
4. It already has the 5 tabs (`Products`, `FAQ`, `Policies`, `Settings`, `Team`) and shadow mode ON.
5. **The prices and details in it are SAMPLES, not real.** Akash must replace them before the bot answers real customers.
6. Share the sheet with the service account email (ends in `iam.gserviceaccount.com`) as **Viewer**.
7. For the Leads sheet: create a blank Google Sheet named **Dulari Leads**, rename its first tab to `Leads`, and share it with the same email as **Editor**.

## Talk to your bot (test conversation), no WhatsApp needed

In the project folder run:

```bash
npm run chat
```

Type like a customer ("Hi, I would like to inquire about: Daily Table"). The bot answers with the real AI, your Brain sheet, product photos and handoff rules. Nothing is sent on WhatsApp, and it works even with an expired Meta token and with shadow mode on. Commands: `/new` starts a new customer, `/quit` exits. A handoff (quote, 5+ pieces, complaint) sends the real alert to your Telegram group, and then the bot stays silent for that test customer, exactly like with a real one.

The same chat is a panel at the bottom of the dashboard page.

## Pilot: only my phones get replies, real leads are ignored

In the Brain sheet, **Settings** tab, add two rows (the template has them):

| key | value |
|---|---|
| `live_numbers` | your test phones with country code, separated by commas, e.g. `919876543210, 919123456789` |
| `only_live_numbers` | `TRUE` |

- Listed phones get **real replies on WhatsApp**, even while `SHADOW_MODE` is TRUE.
- Everyone else is **ignored completely**: no reply, no Telegram draft. Their messages are still stored (so the bot knows them later) and your team keeps answering from the phone as usual.
- To start the shadow week with real leads, set `only_live_numbers` to `FALSE`. Real leads then get **drafts in Telegram only**, and your listed phones still get real replies.
- To go fully live, set `SHADOW_MODE` to `FALSE`, empty `live_numbers`, and set `only_live_numbers` to `FALSE`.

The bot re-reads the sheet every 10 minutes. A sheet mistake (for example a phone number it cannot read) is rejected, the old settings stay, and Telegram tells you which row.
