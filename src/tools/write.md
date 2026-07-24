Write content to a file. Creates parent directories; overwrites existing file.

Parameters:
- path (required): File path, relative to cwd or absolute
- content (required): Full content to write

Notes:
- This overwrites the entire file — use `edit` for targeted changes
- The file is atomic: it either writes completely or fails
