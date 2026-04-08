from openai import OpenAI

client = OpenAI(base_url="http://localhost:8000/v1", api_key="EMPTY")
model = "/scratch/Projects/CFP-03/CFP03-CF-053/yogi/Qwen3.5-397B-A17B"

print("Chat with Qwen3.5-397B (type 'quit' to exit)\n")
while True:
    try:
        q = input("You: ")
    except (EOFError, KeyboardInterrupt):
        break
    if q.strip().lower() in ("quit", "exit", "q"):
        break
    r = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": q}],
        max_tokens=1024,
        temperature=0.6,
    )
    thinking = getattr(r.choices[0].message, "reasoning_content", None)
    answer = r.choices[0].message.content or ""
    if thinking:
        print(f"\n[Thinking]\n{thinking}\n")
    if answer.strip():
        print(f"AI: {answer}\n")
    elif thinking and not answer.strip():
        print(f"AI: (full response was in thinking above)\n")
    else:
        print("AI: (no response)\n")
