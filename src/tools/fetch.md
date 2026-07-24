Fetch a URL and return its content as text. HTML pages are stripped to readable text. Use after websearch to read full documents.

Parameters:
- url (required): http/https URL

Notes:
- Follows redirects automatically
- Timeout: 20 seconds
- HTML pages are converted to plain text (scripts, styles, navigation stripped)
- Non-HTML responses are returned as-is (truncated at ~50000 chars)
