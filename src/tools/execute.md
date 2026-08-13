Execute JavaScript code with full Node access. Use this to compose multiple file operations into one call — read, write, glob, grep, log, or require() any module. Max 30s timeout, 50KB output.

Parameters:
- code (required): JavaScript code to execute. Use provided functions: readFile(path), writeFile(path, content), glob(pattern), grep(pattern, file), log(...args). require()/process/Node modules are available.
- timeoutMs: Timeout in milliseconds (default 30000, max 60000)
