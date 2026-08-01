Execute sandboxed JavaScript code. Use this to compose multiple file operations into one call — read, write, glob, grep, and log results. No network or system access. Max 30s timeout, 50KB output.

Parameters:
- code (required): JavaScript code to execute in the sandbox. Use provided functions: readFile(path), writeFile(path, content), glob(pattern), grep(pattern, file), log(...args).
- timeoutMs: Timeout in milliseconds (default 30000, max 60000)
