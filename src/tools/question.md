Ask the user a question and wait for their response. Use when the task is ambiguous, you need a design decision, or you're stuck and need human judgment.

Parameters:
- question (required): The question to ask the user
- options: Array of single-choice options for the user to pick from (optional)

Notes:
- The agent loop pauses until the user answers
- The answer is injected as the next user message
- Use sparingly — prefer making reasonable decisions when possible
