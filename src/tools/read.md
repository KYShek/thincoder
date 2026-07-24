Read a text file. Returns numbered lines. Use offset/limit to page large files.

Parameters:
- path (required): File path, relative to cwd or absolute
- offset: 1-based line number to start reading from
- limit: Max lines to return (default 2000)

Notes:
- Always prefer this over `cat` or shell-based reading — it caps output and avoids large dumps
- Use offset for pagination when the file is large
