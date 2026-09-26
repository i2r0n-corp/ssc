"""Unit tests for PPTX export tool behaviour."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture(autouse=True)
def add_app_to_path(add_agent_to_path):
    pass


@pytest.fixture
def mock_pptx_tool():
    mock_tool = MagicMock()
    mock_tool.name = "generatePptx"
    mock_tool.ainvoke = AsyncMock(return_value={
        "downloadUrl": "/api/pptx/download/mock-uuid-12345",
        "filename": "catalog-export-short-description-1727222400000.pptx",
        "serviceCount": 3,
        "fileSizeKb": 128
    })
    return [mock_tool]


def _make_llm(text):
    from langchain_core.messages import AIMessage
    mock_llm = MagicMock()
    mock_llm.ainvoke = AsyncMock(return_value=AIMessage(content=text))
    return mock_llm


@pytest.mark.asyncio
async def test_pptx_short_description_export(mock_pptx_tool):
    """Agent should handle PPTX short-description export request."""
    from agent import SampleAgent
    agent = SampleAgent()
    llm = _make_llm(
        "Your PowerPoint is ready! Download here: /api/pptx/download/mock-uuid-12345\n"
        "File: catalog-export-short-description.pptx | 3 services | 128 KB"
    )

    with patch("agent.ChatLiteLLM", return_value=llm):
        response = await agent.invoke(
            "Export these services to PowerPoint with the short description template: "
            "000000000009506207, 000000000009506208",
            context_id="test-pptx-1",
            tools=mock_pptx_tool
        )

    assert response.status == "completed"
    assert response.message


@pytest.mark.asyncio
async def test_pptx_one_pager_export():
    """Agent should handle one-pager template request."""
    one_pager_tool = MagicMock()
    one_pager_tool.name = "generatePptx"
    one_pager_tool.ainvoke = AsyncMock(return_value={
        "downloadUrl": "/api/pptx/download/mock-uuid-67890",
        "filename": "catalog-export-one-pager.pptx",
        "serviceCount": 2,
        "fileSizeKb": 256
    })

    from agent import SampleAgent
    agent = SampleAgent()
    llm = _make_llm(
        "Your one-pager PowerPoint is ready! Download: /api/pptx/download/mock-uuid-67890"
    )

    with patch("agent.ChatLiteLLM", return_value=llm):
        response = await agent.invoke(
            "Generate a one-pager PowerPoint for services 000000000009506207 and 000000000009506208",
            context_id="test-pptx-2",
            tools=[one_pager_tool]
        )

    assert response.status == "completed"


@pytest.mark.asyncio
async def test_pptx_milestone_logged(mock_pptx_tool, caplog):
    """M4 milestone should be logged when PPTX export is triggered."""
    import logging
    from agent import SampleAgent
    agent = SampleAgent()
    llm = _make_llm(
        "Generated and ready to download: /api/pptx/download/mock-uuid-12345"
    )

    with caplog.at_level(logging.INFO, logger="agent"), \
         patch("agent.ChatLiteLLM", return_value=llm):
        await agent.invoke(
            "Export to PowerPoint and download the slides",
            context_id="test-pptx-milestone",
            tools=mock_pptx_tool
        )

    milestone_logs = [r for r in caplog.records if "M4" in r.message]
    assert len(milestone_logs) > 0, "Expected M4 milestone log but none found"


@pytest.mark.asyncio
async def test_pptx_tool_error_relayed():
    """Agent should handle tool errors gracefully."""
    from agent import SampleAgent
    agent = SampleAgent()
    llm = _make_llm("I encountered an error generating the PowerPoint. Please try again.")

    with patch("agent.ChatLiteLLM", return_value=llm):
        response = await agent.invoke(
            "Generate PowerPoint slides",
            context_id="test-pptx-error",
            tools=[]
        )

    assert response.status in ("completed", "error")
