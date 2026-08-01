Read an image file and return it as multimodal content visible to the model. Use this to view screenshots, UI mockups, diagrams, or any visual content. The model only sees images through this tool — it cannot "see" files directly. Supports png, jpg, gif, webp, bmp, svg. The image is base64-encoded and included in the response. Large images (>20MB) are rejected.

Parameters:
- path (required): Path to image file (relative to cwd or absolute). Supports png, jpg, gif, webp, bmp, svg.

Notes:
- This tool only works with models that support vision/image input (Kimi K3, Qwen3.7, MiniMax M3). Pure text models (DeepSeek V4, GLM-5) will receive an error.
