---
description: Set up a daily Windows Task to update stock prices and push to Railway
---

Since the NASDAQ API blocks Railway's data center IPs, we run the price fetcher locally on your Windows machine and push the result to git. Railway then automatically deploys the updated data.

### 1. Open Windows Task Scheduler
1. Press `Win + R`, type `taskschd.msc`, and press Enter.

### 2. Create a New Task
1. In the right pane, click **Create Basic Task**.
2. **Name**: `BullishPricesUpdate`
3. **Description**: `Updates stock prices and pushes to Railway`
4. Click **Next**.

### 3. Set Trigger
1. Select **Daily**.
2. Click **Next**.
3. Set Start: Today's date.
4. Set Time: **6:00:00 PM** (or after market close at 4:30 PM ET).
5. Ensure "Recur every: 1 days" is set.
6. Click **Next**.

### 4. Set Action
1. Select **Start a program**.
2. Click **Next**.
3. **Program/script**: `powershell.exe`
4. **Add arguments**: `-ExecutionPolicy Bypass -File "G:\NewBullish\scripts\daily_price_update.ps1"`
5. **Start in (optional)**: `G:\NewBullish`
6. Click **Next**.

### 5. Finish
1. Check the box **"Open the Properties dialog for this task when I click Finish"**.
2. Click **Finish**.

### 6. Configure Properties (Optional but Recommended)
1. In the properties window that opens:
   - Select **"Run whether user is logged on or not"** (requires password) OR **"Run only when user is logged on"** (easiest, if you leave your PC on).
   - If using "Run whether user is logged on", check "Do not store password" if allowed, or ensure your git credentials (SSH keys) work without interaction.
   - On the **Conditions** tab, uncheck "Start the task only if the computer is on AC power" if you want it to run on a laptop battery.
2. Click **OK**.

### Testing
Right-click the new task in the list and select **Run**.
Check `G:\NewBullish\scripts` for any log output or check your GitHub repo to see if a new commit appeared.
