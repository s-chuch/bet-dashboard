# Background screenshot reading: setup

When this is on, the page uploads your bet-slip screenshot, a server function reads it with Gemini in the background, and you can leave the page: any page shows the result later. If it is off, the page reads screenshots in the browser as before.

## Deploy (one time)

1. Open the Supabase dashboard, SQL editor, paste the whole of `supabase/004_slip_jobs.sql` and run it. It is safe to run twice. It creates the `slip_jobs` table and the private `slips` storage bucket.
2. Install the Supabase CLI (https://supabase.com/docs/guides/cli). On Mac: `brew install supabase/tap/supabase`. On Windows: `scoop install supabase`. Or use `npx supabase ...` instead of `supabase` in the commands below.
3. Log in and link the project (from the repo folder):
   ```
   supabase login
   supabase link --project-ref jzlfbpxcqerwtiurzsmu
   ```
4. Store your Gemini key as a secret on Supabase (get a key at https://aistudio.google.com/apikey):
   ```
   supabase secrets set GEMINI_API_KEY=your-key-here
   ```
   Optional: choose the models, tried in order (default `gemini-2.5-flash,gemini-2.5-pro`):
   ```
   supabase secrets set READ_SLIP_MODELS=gemini-2.5-flash,gemini-2.5-pro
   ```
   The key lives only in Supabase. Never put it in the repo, in a page, or in a commit.
5. Deploy the function:
   ```
   supabase functions deploy read-slip
   ```
   (Leave JWT verification on, which is the default.)
6. Sign in on the site (`login.html`). Jobs need an account, because each job belongs to the signed-in user.

## Test

Sign in, open the page that has the screenshot upload, add a slip screenshot, then close the tab. Open the site again a few seconds later: the finished job and its rows should be there. To check by hand, look at the `slip_jobs` table in the Table editor: `status` goes `queued`, `reading`, then `done` (rows in `result`) or `error` (reason in `error`). The `slips` bucket should be empty again afterwards. Function logs: Dashboard, Edge Functions, read-slip, Logs.

## Turn it off

Delete the function: `supabase functions delete read-slip`. The page then falls back to in-browser reading automatically. You can also remove the secret with `supabase secrets unset GEMINI_API_KEY`.

## Privacy

- The image is deleted from Storage right after reading, whether it worked or failed. Only the extracted rows stay in `slip_jobs.result`.
- Only you can see your own jobs and files (row level security).
- The image is sent to Google's Gemini API. On the Google free tier, Google may use submitted content to improve its products, including training. This is the same note the page already shows. A paid key avoids that.
- The function does not log images, the key, or your prompt.

## Cost and limits

- Gemini free tier has daily and per-minute request caps. If a model is busy or over its limit (429 or 5xx) or takes longer than 45 seconds, the next model in the list is tried. If all fail, the job ends as `error` and you can retry or add the bets by hand.
- Images up to 12 MB (jpeg, png, webp). At most 30 rows are kept per slip. The prompt may be up to 20,000 characters.
- Supabase Edge Functions and Storage free quotas are far above personal use.
- Housekeeping: old jobs can be deleted any time, for example jobs older than 3 days:
  `delete from public.slip_jobs where created_at < now() - interval '3 days';`
