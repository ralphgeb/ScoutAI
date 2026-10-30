# Rumour Radar

Your morning and evening briefing on tech, AI, gadgets and markets, as an iPhone app. It reads about 150 tech, finance, world and fashion news sites from the UK, the US, Europe and Asia, and tags every story with its region. Every story gets its picture and an AI summary with key points, plus the stocks it could move. Rumours get their own tab with AI odds on how likely each one is to be true.

## Already using an older version? Update (about 10 minutes)

### 1. Upload the new files

1. Unzip the new `rumour-radar.zip` and open the folder.
2. In your GitHub repository, click **Add file → Upload files**.
3. Drag in everything **except the `data` folder**, including the `scripts` folder, which has the new `prices.py`.
4. Click **Commit changes**.

### 2. Replace the workflow

1. Open `setup/update-news-workflow.yml` in your repository and click **Copy raw file**.
2. Open `.github/workflows/update-news.yml`, click the **pencil**, select everything, delete it, and paste.
3. Click **Commit changes**.

The new workflow does two things:
- It fetches stock prices with **yfinance**, a free tool installed automatically on GitHub. No key or account is needed.
- It updates **prices every hour on weekdays**.

### 3. Get the first prices

1. Go to **Actions → Update news → Run workflow**.
2. Set **mode** to **stocks** and click **Run workflow**.
3. It takes about 2–3 minutes the first time.

---

## First-time setup

**What you need:** a computer with a web browser, about 25 minutes, and a bank card for about £5 of AI credit. You don't need to install anything or write any code.

**How it works:** GitHub (free) does all the work. At 6:00 each morning London time it reads the news sites, asks Claude to analyse the new articles, writes the briefing, and saves the results. GitHub Pages (also free) hosts the app itself.

---

## Step 1: Make a GitHub account

1. Go to **github.com** and click **Sign up**.
2. Choose a username. It will appear in your app's web address.

## Step 2: Create a home for the app

1. Once signed in, click the **+** at the top right and choose **New repository**.
2. For **Repository name**, type `rumour-radar`.
3. Choose **Public**. The free hosting needs this, and your keys stay private either way.
4. Leave every other option unticked and click **Create repository**.

## Step 3: Upload the files

1. Unzip `rumour-radar.zip` on your computer and open the `rumour-radar` folder.
2. On the new GitHub page, click the link **uploading an existing file**.
3. Select **everything inside** the folder and drag it onto the GitHub page.
   - Drag the files **inside** the folder, not the folder itself.
4. When the upload finishes, click the green **Commit changes** button.

## Step 4: Get your AI key

1. Go to **console.anthropic.com** and sign up.
2. Open **Billing** and add credit. **$5 is plenty to start.** Set a monthly spending limit there too, so you never get a surprise.
3. Open **API keys**, click **Create key**, name it `rumour-radar`, and **copy the key**. It starts with `sk-ant-`.

## Step 5: Give the AI key to GitHub (safely)

1. In your repository, click **Settings**.
2. In the left menu, click **Secrets and variables**, then **Actions**.
3. Click **New repository secret** and fill in the two fields:
   - **Name:** `ANTHROPIC_API_KEY`
   - **Secret:** paste your key
4. Click **Add secret**.

## Step 6: Allow the updater to save news

1. In **Settings**, open **Actions**, then **General**.
2. Scroll to **Workflow permissions**, choose **Read and write permissions**, and click **Save**.

## Step 7: Turn on the automatic updates

1. Open the `setup` folder, click `update-news-workflow.yml`, and click the **Copy raw file** button.
2. Click the **Actions** tab, then **set up a workflow yourself**.
3. Change the file name at the top from `main.yml` to `update-news.yml`.
4. Delete everything in the editor and paste.
5. Click **Commit changes…**, then **Commit changes**.

## Step 8: Run it for the first time

1. Go to **Actions → Update news → Run workflow**.
2. Set **Write a new Today briefing?** to **yes**.
3. Click the green **Run workflow** button.
4. Wait 5–15 minutes for a **green tick**.

## Step 9: Put the app online

1. Go to **Settings → Pages**.
2. Set **Source** to **Deploy from a branch**, **Branch** to **main**, and the folder to **/ (root)**, then click **Save**.
3. After about 2 minutes, a box appears saying **"Your site is live at …"**. That's your app's address.

## Step 10: Add it to your iPhone

1. Open the address in **Safari**.
2. Tap **Share**. If you don't see it, tap **•••** first.
3. Tap **Add to Home Screen**, then **Add**.

---

## Live refresh (the refresh button)

The refresh button at the top right, or pulling down on any tab, always reloads the latest stories. To make it go and **fetch brand-new news from all the sites**, give the app a small GitHub key that can only start updates for this one repository.

**Create the key (on a computer, about 3 minutes):**

1. On GitHub, click your **profile picture** (top right) and choose **Settings**.
2. At the bottom of the left menu, click **Developer settings**.
3. Click **Personal access tokens**, then **Fine-grained tokens**, then **Generate new token**.
4. Fill in the form:
   - **Token name:** `Rumour Radar refresh`
   - **Expiration:** pick the longest option offered.
   - **Repository access:** choose **Only select repositories** and pick your **Rumour-radar** repository.
   - **Permissions:** find **Actions** in the list and set it to **Read and write**. Leave everything else as it is.
5. Click **Generate token** and **copy** it. It starts with `github_pat_`.
   - Email or AirDrop it to yourself so you can paste it on your phone, then delete that message.

**Add it to the app (on your iPhone):**

1. Open the app and go to **Settings → Live refresh**.
2. Paste the key and tap **Save key**. The status changes to **On**.

Tapping refresh (or pulling down) updates the **Tube and weather** straight away and fetches the **latest stock prices** (about a minute). Newly added stocks also get their AI summary. Refresh never re-runs the news, so it costs almost nothing. **News and Today update at 6:00 each morning.** For an extra news update, use **Actions → Update news → Run workflow** on GitHub.

**About safety:**
- The key is stored only on your phone.
- It can only start updates for this one repository. It can't read your other repositories or change your code.
- If you lose your phone, delete the key on GitHub: **Settings → Developer settings → Fine-grained tokens**.

---

## Pictures from WSJ, Reuters and Barron's (optional, about $4 a month)

These sites block automatic tools, so their pictures are found through news search engines instead. DuckDuckGo is tried first (free). For the rest, you can add a **Brave Search** key:

1. Go to **api-dashboard.search.brave.com**, sign up, and choose the **Search** plan (it includes $5 of free use a month; you'll need a card).
2. Set a monthly limit there (for example $10) so it can never cost more.
3. Create an API key and copy it.
4. On GitHub: **Settings → Secrets and variables → Actions → New repository secret**. Name: `BRAVE_API_KEY`, Secret: paste the key.

Without the key, everything still works; those stories just keep their coloured box when DuckDuckGo finds nothing.

## Morning notifications

Rumour Radar can send a notification at about 7:00 each morning with a catchy one-line teaser of your Today topic.

1. Open the app **from your home screen** (notifications don't work in Safari tabs; you need iOS 16.4 or later).
2. Make sure **Live refresh** is on (Settings → Live refresh).
3. Go to **Settings → Notifications** and switch on **Morning briefing at 7:00**. Tap **Allow** when asked.
4. A test notification arrives within about a minute.

How it works: the updater makes the notification keys from your existing `ANTHROPIC_API_KEY` secret, so there's nothing new to set up. Your phone's notification address is encrypted before it is saved on GitHub, so only the updater can read it. If you change your Today topic, the notification follows it. GitHub can start runs a few minutes late, so it usually arrives between 7:00 and 7:15.

## Using the app

The app has four tabs along the bottom.

- **Today** opens with a **live weather card**: the current temperature and conditions, today's high and low, and the forecast every 2 hours for the next 10 hours. It updates every time you open the app. The first time, your iPhone asks for your location. If you say no, it shows London. You can switch between My location and London in **Settings → Weather**. Tap the card to refresh it.
- Under the weather, **Tube status** shows every Tube line and the Elizabeth line, live from TfL, with the time it was updated. Lines with problems are listed first. Tap one to see why. It refreshes every time you open the app. You can hide it in **Settings → Tube status**.
- **Today** is your tech front page. Briefings arrive at 6:00 each morning, London time. Each one has:
  - a cover headline and an overview of what happened
  - the top stories with pictures
  - **Rumour watch**
  - **Stocks to watch**
  - **In brief**

  Earlier briefings are at the bottom.
- **News** has every story from all the sites. The tabs at the top are fixed:
  - **All**, ranked by importance: how big the story is (an AI score), how many outlets cover it, how recent it is, and a small boost for your interests
  - **Tech** (gadgets, AI, companies, startups and VC)
  - **Finance** (Bloomberg, FT, Telegraph, WSJ, Washington Post and more)
  - **World** (BBC, Guardian, Sky, Al Jazeera, NYT, Reuters, Google News top stories and more)
  - **Fashion** (WWD, Business of Fashion, FT, Vogue, British Vogue, Vogue Business, Telegraph, Guardian, Harper's Bazaar, Fashionista, Highsnobiety, Hypebeast)

  Tech, Finance, World and Fashion each open with a **"today" cover**: the main topic, a short summary, the other key stories, and the stocks, indices or currencies to watch.
- **Stocks** lists your own stocks (**My stocks**) and the **top 20 US-listed companies by market value**. Each row shows the day's mini chart, the price and the change.
  - Tap the coloured change to switch between %, the price change and market value.
  - Tap **+** to search about 25,000 stocks, funds, indices, currencies and cryptos worldwide **by company name or ticker**, for example "Scottish Mortgage", "SpaceX" or "BARC.L". The list comes from the free FinanceDatabase project and is refreshed weekly by GitHub. With Live refresh turned on, its price and AI summary arrive in about a minute.
  - Tap **Edit** to remove stocks.
  - Tap a stock to see its full page:
    - price, with 1D, 1M and 1Y charts (touch the chart to read any point)
    - key stats
    - an AI **What's happening** summary
    - every story that mentions the company
  - Prices update **every hour on weekdays** (about 7:20 to 22:20 UK time), plus whenever you refresh on the Stocks tab. That's quicker, as it only updates prices.
  - AI summaries and each stock's headlines are refreshed with the morning and evening briefings.
  - A stock you add gets its price, AI summary and headlines straight away. This needs Live refresh to be on.
- **Rumours**: rumours are marked on each story with the AI's odds (and Today's Tech briefing has Rumour watch). It shows unconfirmed stories with the AI's odds:
  - green: likely
  - amber: toss-up
  - red: unlikely

  Switch to **Confirmed** or **Denied** to see how rumours turned out. A red badge on News counts new rumours.
- **The first time you open the app** it asks for the topic of **Today**: Tech, Fashion, Finance or World. Each has a front page with a longer overview of the day's main events, the key stories and the stocks or brands to watch; Tech also has Rumour watch. The first time you open **News** it asks for your interests (shown under For You).
- **Settings** has these options:
  - **Appearance:** Automatic (follows your iPhone), Light or Dark
  - **Personalise → Today** (change your briefing's topic) and **Personalise → News interests**, each on its own page
  - Live refresh

Tap any story to open it. You'll see:
- the picture
- the **AI summary** with key points
- the rumour check (for rumours)
- the **market impact**: which stocks could move, up ▲ or down ▼, and by how much (●○○ low to ●●● high)
- every outlet covering it

While reading a story, **swipe left for the next story and right for the previous one**. The order is the same as the list you opened it from. There's also an **Up next** card at the end of each story. The button at the bottom opens the original article. Tap a stock to see every story about it. Swipe from the left edge to go back.

## On a computer

Open the same address in a browser on a laptop or desktop (a window at least 1100 pixels wide) and the app switches to a desktop layout: a top bar with the sections, a scrolling markets ticker, News with the section's summary in a column on the left and the stories in a newspaper-style grid on the right, and stories opening in a panel on the right (Esc closes it; the ← → keys move between stories, or between News sections). The iPhone layout is unchanged.

## Changing things later (all in the browser)

To change a file, open it on GitHub, click the **pencil** icon to edit, then **Commit changes**.

- **Add or remove news sites:** edit `feeds.json`. Each line has three parts:
  - the site's name
  - its section (`Tech`, `Finance` or `World`)
  - its RSS feed address
- **Smarter but pricier AI:** in `.github/workflows/update-news.yml`, under `ANTHROPIC_API_KEY: ...`, add a line `ANTHROPIC_MODEL: claude-sonnet-5-5` with the same indentation.
- **Different update times:** these are set near the top of `scripts/due.mjs` (`SLOTS`), in London time. Ask Claude to change them for you.

## Costs

GitHub and the hosting are free. The AI uses Claude Haiku, the cheapest model.

The AI reads each article and writes a summary with key points (no long write-ups, which keeps the cost down). Scheduled updates use Anthropic's batch queue, which costs half as much but can take a while, so they start at 6:00 each morning. On the other hand, updates now run twice a day (plus whenever you tap refresh) instead of every 30 minutes. Each daily update analyses up to 200 new stories, 50 for each of Tech, Finance, World and Fashion, shared fairly between the UK, the US, Europe and Asia (more sources only means better picks: the cap keeps the cost the same), and the app keeps 520 stories (130 per section). The World and Finance summaries cover every region.

Check **console.anthropic.com → Usage** after the first day to see the real cost, and keep a monthly spend limit set there. To spend less, lower `MAX_NEW_PER_RUN` near the top of `scripts/update-news.mjs`.

## If something goes wrong

- **Red ✕ in Actions:** click the failed run, then the step marked ✕, to read the error message.
  - **"API key was rejected"**: redo Step 5, checking the name is exactly `ANTHROPIC_API_KEY`.
  - **"out of credit"**: add credit in the Anthropic console.
  - **Failure at "Save results"**: redo Step 6.
- **Lots of short runs in Actions:** this is normal. Every 30 minutes GitHub checks whether anything is due (the 6:00 update, or prices every 30 minutes). When nothing is, the run finishes in a few seconds and its **update** job shows as skipped. If GitHub starts a run late or skips one, the next check catches up.
- **Refresh says the key was rejected or lacks permission:** create the key again, making sure **Actions** is set to **Read and write** and your repository is selected.
- **A news site shows "failed" in the log:** that site changed or blocked its feed. Delete it from `feeds.json`.
- **A story has a short summary:** some sites block automatic reading. For those, the AI only has the feed summary and keeps it short rather than guessing.

## Good to know

- The app shows each article's headline and preview picture as published by the site. When a site doesn't share a picture (Bloomberg and the FT often don't), the updater looks for the same story at other outlets (via Bing News and the free GDELT news index) and uses that article's picture, credited, for example "Image: Vogue". An AI check makes sure it's the same event; if nothing matches, the story keeps its coloured box with the outlet's name.
- Bloomberg, the FT, Reuters, Barron's and the WSJ are also reached through Google News searches, which gets through more of their headlines.
- CNBC is excluded everywhere.
- The summaries and key points are written by AI in its own words. The app never copies the publishers' articles, and the button on every story opens the original.
- **The summaries, odds and stock impacts are AI-generated. They can be wrong, and they are not financial advice.**
