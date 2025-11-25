# How to Add Your OpenAI API Key

## Step 1: Get Your OpenAI API Key

1. Go to **https://platform.openai.com/api-keys**
2. Sign in to your OpenAI account
3. Click **"Create new secret key"**
4. Copy the key (it starts with `sk-`)
   - ⚠️ **Important**: Copy it immediately - you won't be able to see it again!

## Step 2: Add to .env File

Open `backend/.env` file and find this line:

```env
OPENAI_API_KEY=""
```

Replace it with your actual key:

```env
OPENAI_API_KEY="sk-your-actual-key-here"
```

**Make sure to:**
- Keep the quotes around the key
- Don't add any spaces before or after the `=`
- Don't share your key publicly (it's already in .gitignore)

## Step 3: Verify

Run the check script again:

```bash
cd backend
npx ts-node scripts/check-rag-prerequisites.ts
```

You should see:
```
✅ OpenAI API Key            Found API key (sk-...)
```

## Security Notes

- ✅ Your `.env` file is already in `.gitignore` (won't be committed to git)
- ✅ Never share your API key publicly
- ✅ If your key is exposed, revoke it immediately on OpenAI's website
- ✅ The key gives access to your OpenAI account and billing

## Need Help?

If you're having trouble:
1. Make sure the key starts with `sk-`
2. Make sure there are no extra spaces
3. Make sure the quotes are correct
4. Restart your backend server after adding the key



