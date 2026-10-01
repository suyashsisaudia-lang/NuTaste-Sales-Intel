"""
Voice input for the Ask boxes.

The browser records a short WAV clip and posts it here; the model transcribes it
and the text goes back into the Ask box for the person to read before pressing
Ask. Nothing is asked on their behalf: a misheard outlet name must be seen and
corrected, not silently turned into an answer about the wrong outlet.

Transcription runs on the server with the same key and failover walk as the
rest of Ask, so it behaves the same in every browser, and the audio goes to
Gemini alone rather than to whichever speech service the browser ships with.
"""
import array
import io
import math
import sys
import wave

# WAV is the one format every browser can produce (encoded in voice.js) and
# every Gemini model accepts, so it is the only one taken.
ACCEPTED_MIME = {"audio/wav", "audio/x-wav", "audio/wave"}

# No language is chosen in the browser: salespeople speak English, Hindi, or —
# most often — Hindi with English business words mixed in, sometimes within one
# sentence. The model hears which it is and writes each word in its own script.
SYSTEM = """You transcribe one short spoken question from a salesperson in India into text.
You are a transcriber, not an assistant.

Language:
- The speaker may use English, Hindi, or the everyday mix of the two (Hindi
  sentences with English words in them, or the other way round). Work out what
  was spoken yourself; no language is set in advance.
- Write English words in English (Latin) letters and Hindi words in Devanagari,
  exactly as each was spoken. Do not translate either into the other.
- A word the speaker SAID in English stays in English letters even inside a
  Hindi sentence (sales, outlet, visit, demo, lead, target, km, invoice,
  overdue, customer, month). A word they said in Hindi stays in Hindi: never
  swap it for its English equivalent — दुकान stays दुकान, बिक्री stays बिक्री.
- Names of outlets, customers, companies, cities, regions, products and brands:
  always in English letters, spelled the way an Indian business would write them.
- Numbers: write them as digits.

Accuracy:
- Write down exactly what was said. Do not answer it, summarise it, correct its
  grammar or add anything to it.
- Clips are often silent or only background noise; that is normal. If you
  cannot clearly hear a spoken question, set `heard` to false and leave `text`
  empty. Never invent, complete or guess at a question. An empty result is
  always better than a plausible one.
"""

PROMPT = "Transcribe the attached audio."

SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "text": {"type": "STRING", "description": "The question exactly as spoken."},
        "heard": {"type": "BOOLEAN",
                  "description": "False if no intelligible speech was in the clip."},
    },
    "required": ["text", "heard"],
}


# Loudest 50 ms window below this RMS (16-bit scale, about -44 dBFS) counts as
# no speech at all. Checked before the model is called because, given silence,
# a model will happily transcribe a question nobody asked.
SPEECH_RMS_FLOOR = 200


def has_speech(data: bytes) -> bool:
    """True if a 16-bit PCM WAV clip contains anything loud enough to be speech."""
    try:
        with wave.open(io.BytesIO(data), "rb") as w:
            if w.getsampwidth() != 2:
                return True          # not a format we can measure; let the model decide
            rate, channels = w.getframerate(), w.getnchannels()
            frames = w.readframes(w.getnframes())
    except (wave.Error, EOFError):
        return False
    samples = array.array("h")
    samples.frombytes(frames[: len(frames) - len(frames) % 2])
    if sys.byteorder == "big":
        samples.byteswap()
    step = max(1, int(rate * channels * 0.05))
    for i in range(0, len(samples), step):
        win = samples[i:i + step]
        if win and math.sqrt(sum(x * x for x in win) / len(win)) >= SPEECH_RMS_FLOOR:
            return True
    return False
