# Claude and Codex re-authentication from an iPhone

The native Apple Shortcut uses the existing `server-maintenance.yml` workflow on
`main`. It runs on an iPhone without a running Mac, SSH client, or shell action.
The workflow must already have completed at least one maintenance run.

## Build and install on a Mac

The generator uses Python 3.9 or newer and macOS's built-in `shortcuts` command.
Choose a private directory **outside the repository** for generated files.

Generate a preview without a credential:

```sh
python3 scripts/build-reauth-shortcut.py \
  --output /private/tmp/reauth-preview.unsigned.shortcut
shortcuts sign --mode people-who-know-me \
  --input /private/tmp/reauth-preview.unsigned.shortcut \
  --output '/private/tmp/订阅重新认证.shortcut'
```

In Shortcuts, choose **File → Import**, select the signed file, review its actions,
and add it. The imported shortcut takes its name from the signed filename. The
preview stops with a configuration message before making a network request.

For a version that asks for the GitHub token on each run, add `--ask-token` to the
generator command. It does not store that token in the shortcut.

To deliberately save the current local GitHub CLI credential in the personal
shortcut, use `--from-gh` instead. This reads `gh auth token` without printing it.
The token must have permission to read Actions runs/logs and dispatch workflows
for this repository; a fine-grained token needs Actions read/write permission.
Saving it creates another bearer credential that will sync with the shortcut.
Only do this after choosing to save and sync that credential. Keep both generated
files private, do not commit them, and do not share/export the configured shortcut.
Use `people-who-know-me` signing; `anyone` signing sends a copy to Apple for validation.

The generator refuses output inside the repository and creates unsigned files
with mode `0600`. Use fresh output filenames when rebuilding. Signed files also
need private permissions if they contain a token.

## Use on an iPhone

The menu has a start and a submit item for each provider. Use the pair for the
account you are renewing.

1. Run **订阅重新认证 → Claude：开始浏览器授权** (or **Codex：开始浏览器授权**). Keep
   Shortcuts in the foreground while it dispatches and waits for the workflow. It
   downloads the run's log ZIP, extracts the authorization URL, and opens it in
   your browser.
2. Sign in and approve. The browser then fails to open a `localhost` page (port
   54545 for Claude, 1455 for Codex); that is expected. Copy the full address-bar
   URL (or, for Claude, the `code#state` text if one is shown). The pending login
   expires after a few minutes.
3. Run **订阅重新认证 → Claude：提交授权码** (or **Codex：提交授权码**), paste it, and
   keep Shortcuts open while it waits. It is sent as the workflow's masked `callback`
   input. A success alert means the matching `*-login-complete` run saved the
   credential and passed a live inference call.
4. **查看最近结果** shows the latest maintenance status and opens its Actions run.
   A successful *start* run only means a link was generated; confirm the *complete*
   run when checking whether re-authentication succeeded.

Use one login session at a time; do not repeatedly select a “开始浏览器授权” item. Discovery filters by workflow,
`main`, dispatch event, and GitHub actor, and compares the newest run ID with the
ID before dispatch. Concurrent dispatches by the same actor can still interfere;
avoid using the web workflow and shortcut simultaneously.

The shortcut waits up to one minute to discover a new run and six minutes for it
to finish. On failure or timeout, it points to Actions and does not claim success
or automatically resubmit a one-time code. A delayed run may continue on GitHub
after the shortcut times out; check its result before trying again.

## Check iCloud sync

On the Mac, enable **Shortcuts → Settings → General → iCloud Sync**. On the iPhone,
use the same Apple Account, enable Shortcuts in iCloud, and open **Shortcuts → All
Shortcuts**. Confirm that **订阅重新认证** appears and has all five menu items.
Run **查看最近结果** on the phone to verify its GitHub access and result prompt.
Checking the Mac's setting alone does not prove that the phone received it.

Apple's [Mac sync guide](https://support.apple.com/guide/shortcuts-mac/apdb3a4240b0/mac)
explains the Apple Account and iCloud Sync requirements. The shortcut uses GitHub's
[workflow dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
and [workflow run/log](https://docs.github.com/en/rest/actions/workflow-runs)
APIs; it does not retrieve production SSH or provider secrets.
