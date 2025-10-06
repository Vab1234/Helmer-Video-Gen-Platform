# Helmer-Video-Gen-Platform
An AI-powered video generation system that leverages agentic AI to automate the entire content creation pipeline. Instead of relying on manual editing, the system intelligently plans, structures, and generates video content directly from user input. 


Implementation: (27-09-25 to 4-10-25)

We tried to find methods to get the relevance between fetched assets and user prompts. So we used ViTs.

Why ViTs?        
Vision Transformers capture global patch-wise context and relationships across a scene, making them well-suited for relational and interaction-focused prompts.

Key finding 
Across experiments, ViT-L-14 (larger ViT) produced more semantically accurate rankings for interaction/relational prompts compared to smaller ViTs (e.g., ViT-B-32) and ALIGN in our setup.

Model comparison   — ViT-B-32: fast & lightweight, good for object-level matches; ViT-L-14: larger capacity, better composition/interaction understanding; ALIGN: strong alignment but heavier and requires special preprocessing.

Notebooks / Scripts

1. ViT-L-14.ipynb      — Loads and runs the ViT-L-14 OpenCLIP model to embed prompts and assets, print ranked results, and visualize top matches for single-model experiments.
2. OpenClip.ipynb      — Demonstrates OpenCLIP workflows (e.g., ViT-B-32), tokenization/encode_text debugging, embedding examples, and quick diagnostics.
3. ALIGN.ipynb         — Experiments with HuggingFace kakaobrain/align-base: preprocessing, text/image embedding, similarity computation, and resource notes.
4. Ensemble.ipynb      — Implements model fusion (min-max norm, weighted averaging), compares rankings
