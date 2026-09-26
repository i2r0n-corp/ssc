"""End-to-end integration test: incident upload → analysis → PPTX export."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture(autouse=True)
def add_app_to_path(add_agent_to_path):
    pass


SAMPLE_INCIDENTS = """Incident ID,Description
INC-001,Performance issues during month-end close in SAP Finance
INC-002,Integration failures between SAP and CRM system
"""


@pytest.fixture
def mock_all_tools():
    search_tool = MagicMock()
    search_tool.name = "searchServices"
    search_tool.ainvoke = AsyncMock(return_value={
        "count": 2,
        "services": [
            {"code": "000000000009506207", "name": "Performance Advisory Service",
             "shortDescription": "Optimize SAP performance.", "engagementType": "Max Success Plan",
             "businessScenarioNaming": {}, "parentCode": "MAX00001-01"},
            {"code": "000000000009506208", "name": "Integration Health Check",
             "shortDescription": "Validate integrations.", "engagementType": "Max Success Plan",
             "businessScenarioNaming": {}, "parentCode": "MAX00001-02"}
        ]
    })

    pptx_tool = MagicMock()
    pptx_tool.name = "generatePptx"
    pptx_tool.ainvoke = AsyncMock(return_value={
        "downloadUrl": "/api/pptx/download/e2e-mock-uuid",
        "filename": "catalog-export.pptx",
        "serviceCount": 2,
        "fileSizeKb": 95
    })

    return [search_tool, pptx_tool]


@pytest.mark.asyncio
async def test_full_incident_to_pptx_flow(mock_all_tools):
    """
    E2E: User uploads incidents → agent recommends services → user requests PPTX.
    All external calls (LLM, MCP tools) are mocked for offline execution.
    """
    from langchain_core.messages import AIMessage
    from agent import SampleAgent

    agent = SampleAgent()

    call_count = [0]
    responses = [
        "Based on your incidents, I recommend:\n"
        "1. Performance Advisory Service\n2. Integration Health Check",
        "Your PowerPoint is ready! Download: /api/pptx/download/e2e-mock-uuid"
    ]
    mock_llm = MagicMock()
    async def side_effect(*args, **kwargs):
        idx = call_count[0]
        call_count[0] += 1
        return AIMessage(content=responses[min(idx, len(responses) - 1)])
    mock_llm.ainvoke = AsyncMock(side_effect=side_effect)

    # Turn 1: Incident analysis
    with patch("agent.ChatLiteLLM", return_value=mock_llm):
        response1 = await agent.invoke(
            f"Please analyze these customer incidents:\n{SAMPLE_INCIDENTS}",
            context_id="e2e-context",
            tools=mock_all_tools
        )
    assert response1.status == "completed"
    assert response1.message

    # Turn 2: PPTX export
    with patch("agent.ChatLiteLLM", return_value=mock_llm):
        response2 = await agent.invoke(
            "Yes, export them as a short-description PowerPoint",
            context_id="e2e-context",
            tools=mock_all_tools
        )
    assert response2.status == "completed"
    assert response2.message


@pytest.mark.asyncio
async def test_agent_importable(add_agent_to_path):
    """Agent module should be importable and the agent class should be instantiable."""
    from agent import SampleAgent, AgentResponse
    agent = SampleAgent()
    assert agent is not None
    assert hasattr(agent, "invoke")
    assert hasattr(agent, "stream")
    assert hasattr(agent, "_run_agent")
