"""Unit tests for incident analysis flow."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture(autouse=True)
def add_app_to_path(add_agent_to_path):
    pass


SAMPLE_INCIDENT_CSV = """Incident ID,Description,Category,Priority
INC-001,System performance degradation during month-end close,Performance,High
INC-002,Data migration errors from legacy system,Data Migration,Critical
INC-003,Integration failures between SAP and third-party system,Integration,High
"""


@pytest.fixture
def mock_search_tool():
    mock_tool = MagicMock()
    mock_tool.name = "searchServices"
    mock_tool.ainvoke = AsyncMock(return_value={
        "count": 2,
        "services": [
            {
                "code": "000000000009506210",
                "name": "SAP Performance Optimization Service",
                "shortDescription": "Optimize SAP system performance for critical business processes.",
                "engagementType": "Max Success Plan",
                "businessScenarioNaming": {"MAX00003": "Performance Services"},
                "parentCode": "MAX00003-01"
            }
        ]
    })
    return [mock_tool]


def _make_llm(text):
    from langchain_core.messages import AIMessage
    mock_llm = MagicMock()
    mock_llm.ainvoke = AsyncMock(return_value=AIMessage(content=text))
    return mock_llm


@pytest.mark.asyncio
async def test_incident_analysis_csv_returns_recommendations(mock_search_tool):
    """Agent should process CSV incident content and return a completed response."""
    from agent import SampleAgent
    agent = SampleAgent()
    llm = _make_llm("Based on the incidents, I recommend: 1. Performance Optimization Service")

    query = f"Analyze these customer incidents and recommend services:\n{SAMPLE_INCIDENT_CSV}"
    with patch("agent.ChatLiteLLM", return_value=llm):
        response = await agent.invoke(query, context_id="test-incident-1", tools=mock_search_tool)

    assert response.status == "completed"
    assert response.message


@pytest.mark.asyncio
async def test_incident_analysis_milestone_logged(mock_search_tool, caplog):
    """M3 milestone should be logged for incident analysis queries."""
    import logging
    from agent import SampleAgent
    agent = SampleAgent()
    llm = _make_llm("Based on the uploaded incidents, here are matching services.")

    query = f"These are customer incidents, please analyze: {SAMPLE_INCIDENT_CSV}"
    with caplog.at_level(logging.INFO, logger="agent"), \
         patch("agent.ChatLiteLLM", return_value=llm):
        await agent.invoke(query, context_id="test-incident-2", tools=mock_search_tool)

    milestone_logs = [r for r in caplog.records if "M3" in r.message]
    assert len(milestone_logs) > 0, "Expected M3 milestone log but none found"


@pytest.mark.asyncio
async def test_incident_analysis_empty_content():
    """Agent should handle empty incident content gracefully."""
    from agent import SampleAgent
    agent = SampleAgent()
    llm = _make_llm("I could not find any incidents to analyze.")

    with patch("agent.ChatLiteLLM", return_value=llm):
        response = await agent.invoke(
            "Analyze this incident file: (empty)",
            context_id="test-incident-empty",
            tools=[]
        )

    assert response.status in ("completed", "error")
