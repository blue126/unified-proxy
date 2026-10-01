# Claude re-authentication from an iPhone

The native Apple Shortcut uses the existing `server-maintenance.yml` workflow on
`main`. It runs on an iPhone without a running Mac, SSH client, or shell action.
The workflow must already have completed at least one maintenance run.

## Build and install on a Mac

The generator uses Python 3.9 or newer and macOS's built-in `shortcuts` command.
Choose a private directory **outside the repository** for generated files.

Generate a preview without a credential:

```sh
python3 scripts/build-claude-shortcut.py \
  --output /private/tmp/claude-preview.unsigned.shortcut
shortcuts sign --mode people-who-know-me \
  --input /private/tmp/claude-preview.unsigned.shortcut \
  --output '/private/tmp/Claude 重新认证.shortcut'
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

1. Run **Claude 重新认证 → 开始浏览器授权**. Keep Shortcuts in the foreground while
   it dispatches and waits for the workflow. It downloads the run's log ZIP,
   extracts the Claude authorization URL, and opens it in your browser.
2. Sign in and complete the browser authorization. Copy the full, single-line
   `code#state` displayed by Claude. The pending login expires after 15 minutes.
3. Run **Claude 重新认证 → 提交授权码**, paste that exact line, and keep Shortcuts
   open while it waits. A success alert means `claude-login-complete` finished
   successfully, including credential saving, service startup, and live inference.
4. **查看最近结果** shows the latest maintenance status and opens its Actions run.
   A successful *start* run only means a link was generated; confirm the *complete*
   run when checking whether re-authentication succeeded.

Use one login session at a time. Do not repeatedly select “开始浏览器授权”: the
server replaces the pending session each time. Discovery filters by workflow,
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
Shortcuts**. Confirm that **Claude 重新认证** appears and has all three menu items.
Run **查看最近结果** on the phone to verify its GitHub access and result prompt.
Checking the Mac's setting alone does not prove that the phone received it.

Apple's [Mac sync guide](https://support.apple.com/guide/shortcuts-mac/apdb3a4240b0/mac)
explains the Apple Account and iCloud Sync requirements. The shortcut uses GitHub's
[workflow dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
and [workflow run/log](https://docs.github.com/en/rest/actions/workflow-runs)
APIs; it does not retrieve production SSH or provider secrets.
