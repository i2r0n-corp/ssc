---
name: incident-analysis
description: Parse uploaded customer incident files (CSV, Excel, or plain text), extract pain-point keywords and themes, match against the SSC Services Catalog, and return ranked service recommendations with rationale.
---

# Incident Analysis Skill

## When to Use This Skill

Load this skill when:
- The user uploads a customer incident file (CSV, Excel, or plain text)
- The user says "analyze this file", "these are customer issues", "match these incidents to services"
- The user wants to find catalog services that address specific customer pain points

## Prerequisites

Before starting:
- The user must have provided file content (text extracted from CSV, Excel, or TXT file)
- The catalog snapshot must be available (call `searchServices` to verify)

## Instructions

### Step 1: Parse the Incident Content

Identify the file type from the user's message or filename:
- **CSV**: rows with headers such as "Incident ID", "Description", "Category", "Priority"
- **Excel (text extract)**: similar tabular structure
- **Plain text**: free-form description of customer issues or pain points

Extract the following from each incident row (or from free-form text):
- Main complaint or issue description
- Category or area (if available, e.g., "System Performance", "Data Migration", "Integration")
- Product or module mentioned (if any)

### Step 2: Extract Search Terms

From the extracted content, identify 3–8 key themes or pain-point keywords. Examples:
- "performance degradation" → "performance optimization"
- "data migration errors" → "data migration"
- "integration failures" → "integration"
- "user adoption" → "adoption", "training"

### Step 3: Search the Catalog

For each identified theme, call the `searchServices` MCP tool with:
- `query`: the theme keyword(s)
- `engagementType`: apply if the user specified one (e.g., "Max Success Plan")

Collect the top matches across all searches, deduplicating by service code.

### Step 4: Rank and Filter Results

Rank the matched services by:
1. How many incident themes the service addresses (more = higher rank)
2. Relevance of service description to the specific incidents

Cap results at 15 services. If fewer than 3 services are found, broaden the search terms and try again.

### Step 5: Format Recommendations

Return the recommendations as a structured list, for each service providing:
- Service name
- Short description
- Engagement type
- Relevance rationale: a 1–2 sentence explanation of why this service addresses the customer's incidents

## Guardrails

- File size: reject content over 1 MB in length (character count > 1,000,000)
- Supported formats: CSV, Excel text extract, plain text only
- Never fabricate services — only return services from actual catalog search results
- If no matches are found, inform the user clearly and suggest broadening the search

## Error Handling

- Malformed CSV → inform user, ask them to verify the file format
- No matches → suggest the user try with a different engagement type filter or broader keywords
- Catalog unavailable → relay the tool error verbatim
