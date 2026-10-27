from .provider import GroqVoice

def register(ctx):
    ctx.register_transcription_provider(GroqVoice())
