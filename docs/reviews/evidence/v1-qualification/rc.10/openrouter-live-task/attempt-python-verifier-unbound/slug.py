import re

def slugify(text: str) -> str:
    """Convert display text into a lowercase, hyphen-separated ASCII slug."""
    # Trim surrounding whitespace
    text = text.strip()
    # Lowercase ASCII letters
    text = text.lower()
    # Replace each run of non-ASCII-alphanumeric characters with one hyphen
    text = re.sub(r'[^a-z0-9]+', '-', text)
    # Strip leading/trailing hyphens
    text = text.strip('-')
    return text
