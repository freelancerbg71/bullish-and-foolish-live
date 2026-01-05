# Mobile Price Update Setup

This guide explains how to set up the mobile price update feature, which allows you to update `prices.json` from your phone when you don't have access to your laptop.

## How It Works

1. **Visit** `bullishandfoolish.com/admin/prices` on your phone
2. **Authenticate** with your admin key
3. **Option A:** Click "Update Prices Now" (tries to fetch directly from NASDAQ - may fail)
4. **Option B:** Manual workflow:
   - Click "Download from NASDAQ" → downloads the screener data to your phone
   - Select the downloaded file
   - Click "Convert & Push to GitHub"

The page converts the NASDAQ format to your `prices.json` format and pushes directly to your GitHub repo.

## Required Environment Variables (Railway)

Set these in your Railway project settings:

```env
# Required: A secret key you'll enter when accessing the admin page
ADMIN_KEY=your-secret-admin-key-here

# Required: GitHub Personal Access Token with 'repo' scope
# Create at: https://github.com/settings/tokens (classic token)
# Permissions needed: repo (full control of private repositories)
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx

# Optional: Override if your repo is different
GITHUB_REPO=freelancerbg71/bullish-and-foolish-live
GITHUB_BRANCH=main
```

## Creating a GitHub Token

1. Go to https://github.com/settings/tokens?type=beta (fine-grained) or https://github.com/settings/tokens (classic)
2. For **Classic Token**:
   - Click "Generate new token (classic)"
   - Name: "Bullish Price Updater"
   - Expiration: 90 days (or custom)
   - Scopes: Check `repo` (full control of private repositories)
   - Generate and copy the token

3. For **Fine-grained Token** (more secure):
   - Click "Generate new token"
   - Name: "Bullish Price Updater"
   - Repository access: "Only select repositories" → select `bullish-and-foolish-live`
   - Permissions → Repository permissions:
     - Contents: Read and write
   - Generate and copy the token

## Testing Locally

1. Create a `.env.local` file with:
   ```env
   ADMIN_KEY=test123
   GITHUB_TOKEN=ghp_your_token_here
   ```

2. Start the server:
   ```bash
   node server.js
   ```

3. Visit `http://localhost:3003/admin/prices`

4. Enter `test123` as the admin key

5. Try the update workflow

## Security Notes

- The `/admin/prices` page is NOT linked anywhere on the site
- It requires authentication with your `ADMIN_KEY`
- The page sets `noindex, nofollow` to prevent search engine indexing
- GitHub token is never exposed to the browser - only used server-side

## Troubleshooting

### "Failed to get price data"
- NASDAQ is likely blocking Railway's IP. Use the manual download workflow.

### "GITHUB_TOKEN not configured"
- Set the `GITHUB_TOKEN` environment variable in Railway

### "GitHub API error: 403"
- Your token may have expired or lacks permissions
- Generate a new token with `repo` scope

### "Invalid or missing admin key"
- Enter the correct `ADMIN_KEY` value you set in Railway
