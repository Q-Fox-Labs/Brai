"""Pure data schema for the Hermes Desktop/dashboard memory configuration panel."""

from plugins.memory.config_schema import ProviderConfigSchema, ProviderField, KIND_NUMBER

CONFIG_SCHEMA = ProviderConfigSchema(
    name="memos-rest", label="MemOS REST",
    docs_url="https://hermes-agent.nousresearch.com/docs/developer-guide/memory-provider-plugin/",
    fields=(
        ProviderField("base_url", "Local MemOS API", default="http://127.0.0.1:8001", inline=True),
        ProviderField("user_id", "Existing owner ID", default="root", inline=True),
        ProviderField("cube_id", "Existing MemCube", default="main", inline=True),
        ProviderField("top_k", "Recall results", kind=KIND_NUMBER, default="6"),
        ProviderField("context_chars", "Maximum recalled characters", kind=KIND_NUMBER, default="6000"),
        ProviderField("relativity", "Relevance threshold", kind=KIND_NUMBER, default="0.45"),
    ),
)
