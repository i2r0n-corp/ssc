"""Unit tests for catalog query tool behaviour."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture(autouse=True)
def add_app_to_path(add_agent_to_path):
    pass


@pytest.fixture
def mock_mcp_tools():
    mock_tool = MagicMock()
    mock_tool.name = "searchServices"
    mock_tool.ainvoke = AsyncMock(return_value={
        "count": 2,
        "services": [
            {
                "code": "000000000009506207",
                "name": "SAP IBP Planning Excellence Service",
                "shortDescription": "Helps customers optimize their integrated business planning setup.",
                "engagementType": "Max Success Plan",
                "businessScenarioNaming": {"MAX00001": "Planning & Supply Chain Services"},
                "parentCode": "MAX00001-01"
            }
        ]
    })
    return [mock_tool]


def _make_llm(text="I found services matching your query."):
    from langchain_core.messages import AIMessage
    mock_llm = MagicMock()
    mock_llm.ainvoke = AsyncMock(return_value=AIMessage(content=text))
    mock_llm.astream = AsyncMock(return_value=iter([]))
    return mock_llm


@pytest.mark.asyncio
async def test_catalog_query_returns_results(mock_mcp_tools):
    """Agent should process a catalog query and return a completed response."""
    from agent import SampleAgent
    agent = SampleAgent()
    llm = _make_llm("I found 2 services for Max Success Plan related to SAP IBP.")

    with patch("agent.ChatLiteLLM", return_value=llm):
        response = await agent.invoke(
            "Which services are in Max Success Plan for SAP IBP?",
            context_id="test-context-1",
            tools=mock_mcp_tools
        )

    assert response.status == "completed"
    assert response.message


@pytest.mark.asyncio
async def test_catalog_query_milestone_logged(mock_mcp_tools, caplog):
    """M2 milestone should be logged when a catalog query is processed."""
    import logging
    from agent import SampleAgent
    agent = SampleAgent()
    llm = _make_llm("Here are the services for Max Success Plan.")

    with caplog.at_level(logging.INFO, logger="agent"), \
         patch("agent.ChatLiteLLM", return_value=llm):
        await agent.invoke(
            "Which services are in Max Success Plan?",
            context_id="test-context-2",
            tools=mock_mcp_tools
        )

    milestone_logs = [r for r in caplog.records if "M2" in r.message]
    assert len(milestone_logs) > 0, "Expected M2 milestone log but none found"


@pytest.mark.asyncio
async def test_catalog_query_no_tools_graceful():
    """Agent should handle gracefully when no tools are available."""
    from agent import SampleAgent
    agent = SampleAgent()
    llm = _make_llm("Tools are temporarily unavailable.")

    with patch("agent.ChatLiteLLM", return_value=llm):
        response = await agent.invoke(
            "Show me services for Max Success Plan",
            context_id="test-no-tools",
            tools=[]
        )

    assert response.status in ("completed", "error")
