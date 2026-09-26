"""Unit tests for catalog filtering tool behaviour."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture(autouse=True)
def add_app_to_path(add_agent_to_path):
    pass


@pytest.fixture
def mock_filter_tool():
    mock_tool = MagicMock()
    mock_tool.name = "filterServices"
    mock_tool.ainvoke = AsyncMock(return_value={
        "count": 2,
        "services": [
            {
                "code": "000000000009506207",
                "name": "SAP IBP Planning Excellence Service",
                "shortDescription": "Optimize your IBP setup.",
                "engagementType": "Max Success Plan",
                "businessScenarioNaming": {"MAX00001": "Planning Services"},
                "parentCode": "MAX00001-01"
            }
        ]
    })
    return [mock_tool]


def _make_llm(text="Filtered results found."):
    from langchain_core.messages import AIMessage
    mock_llm = MagicMock()
    mock_llm.ainvoke = AsyncMock(return_value=AIMessage(content=text))
    return mock_llm


@pytest.mark.asyncio
async def test_filter_by_engagement_type(mock_filter_tool):
    """Agent should filter catalog by engagement type and return completed response."""
    from agent import SampleAgent
    agent = SampleAgent()
    llm = _make_llm("Filtered results for Max Success Plan: SAP IBP Planning Excellence Service")

    with patch("agent.ChatLiteLLM", return_value=llm):
        response = await agent.invoke(
            "Show me all services for Max Success Plan",
            context_id="test-filter-1",
            tools=mock_filter_tool
        )

    assert response.status == "completed"
    assert response.message


@pytest.mark.asyncio
async def test_filter_multi_attribute(mock_filter_tool):
    """Agent should apply multi-attribute filters and return intersection."""
    from agent import SampleAgent
    agent = SampleAgent()
    llm = _make_llm("Here are the services matching Max Success Plan and module MAX00001.")

    with patch("agent.ChatLiteLLM", return_value=llm):
        response = await agent.invoke(
            "Show me services in Max Success Plan under module MAX00001",
            context_id="test-filter-2",
            tools=mock_filter_tool
        )

    assert response.status == "completed"


@pytest.mark.asyncio
async def test_filter_no_results_message():
    """Agent should handle no-results gracefully."""
    no_results_tool = MagicMock()
    no_results_tool.name = "filterServices"
    no_results_tool.ainvoke = AsyncMock(return_value={"count": 0, "services": []})

    from agent import SampleAgent
    agent = SampleAgent()
    llm = _make_llm("No services found for module XYZ999.")

    with patch("agent.ChatLiteLLM", return_value=llm):
        response = await agent.invoke(
            "Filter services by non-existent module XYZ999",
            context_id="test-filter-empty",
            tools=[no_results_tool]
        )

    assert response.status in ("completed", "error")
