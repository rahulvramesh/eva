# Python sessions

Eva Cloud exposes a `python_session` model tool backed by the stable Cloudflare Sandbox Code Interpreter API. It is a controlled notebook-like execution surface, not a publicly exposed Jupyter server.

## Behavior

- Each Eva user has an isolated Sandbox container.
- Each chat has its own Python code context, so variables and imports do not leak into other chats.
- The context stays warm until the Sandbox sleeps after ten minutes of inactivity.
- After a restart, Eva creates a new context and reports that live variables expired.
- Every submitted cell is written directly through the R2 binding to `users/<user-id>/workspace/chats/<chat-id>/python/cells/` before execution.
- The direct R2 journal avoids making kernel availability depend on the mounted R2 filesystem. The `/workspace/data` mount remains available for durable user files when healthy.

The base image is pinned to `cloudflare/sandbox:0.12.5-python` and includes Python 3.11, IPython, NumPy, pandas, and Matplotlib. Eva adds `bc`, `jq`, and `ripgrep` for common shell work.

## Agent routing

Eva should use `python_session` for calculations, algorithms, structured data transformations, plotting, and reliable replacements for missing shell calculation utilities. It should use Bash for Git, builds, filesystem operations, installed programs, and package management, and `web_fetch` for public web content.

Every Python cell currently requires explicit approval. Code, previews, outputs, and errors use the same credential-redaction path as Bash. Executions have a 120-second timeout and a 64 KiB normalized output limit.

## Verification

Run the repository gate before deployment:

```bash
pnpm check
pnpm cloud:deploy
```

Then verify through an authenticated Eva chat:

1. Ask Eva to use Python to set `eva_kernel_value = 41` and evaluate `eva_kernel_value + 1`.
2. Approve the Python card and confirm the result is `42`.
3. In the same chat, ask it to evaluate the expression again without redefining the variable. The tool output must report a warm session and return `42`.
4. Start another chat and execute `20 + 22`. The tool output must report a new session and return `42`.
5. Retrieve the reported cell key from R2 and confirm it contains the submitted Python code.

The live context is an optimization; R2 files and the cell journal are the durable source of truth.
