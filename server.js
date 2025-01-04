const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios');
const OpenAI = require('openai');
const { zodResponseFormat } = require("openai/helpers/zod");
const { z } = require("zod");

const app = express();
const port = process.env.PORT || 3000;

// Configure OpenAI API
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const GROUND_NEWS_API_URL = 'https://web-api-cdn.ground.news/api/public/search/url';

// Middleware
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const WeightSchema = z.object({
  data: z.array(
    z.object({
      category: z.string(),
      weight: z.number(),
      facts: z.array(z.string()), // Array of fact strings
      reasoning: z.string(),
    })
  )
});

// Helper to fetch real sources
const fetchRealSources = async (fact) => {
  try {
    const searchResponse = await axios.get(`https://www.googleapis.com/customsearch/v1`, {
      params: {
        key: process.env.GOOGLE_API_KEY,
        cx: process.env.CUSTOM_SEARCH_ENGINE_ID,
        q: fact,
        num: 3,
      },
    });

    return (
      searchResponse.data.items?.map((item) => ({
        title: item.title,
        link: item.link,
        snippet: item.snippet,
      })) || []
    );
  } catch (error) {
    console.error(`Error fetching sources for fact: ${fact}`, error.message);
    return [];
  }
};

// Logic-based weight and hours calculation
const calculateWeightsAndHours = (categories, daysPerYear) => {
  const totalAvailableHours = daysPerYear * 24; // Total hours in the year
  let totalWeight = 0;
  let relevanceModifier = 1;

  const enrichedCategories = categories.map((category) => {
    if (category.category == "Personal Relevance") {
      relevanceModifier = 1 + category.weight/10;
    }
    const weight = category.weight; // Use the existing weight directly
    totalWeight += weight;

    return { ...category, weight };
  });

  // Scale totalHours proportionally to totalAvailableHours
  const averageWeight = totalWeight / categories.length;
  const totalHours = Math.round((averageWeight / 10) * (totalAvailableHours / 5) * relevanceModifier); // Scale down by a factor of 5
  const modifiedDescription = relevanceModifier > 1 ? ` times personal relevance modifier ${relevanceModifier} ` : '';
  const totalHoursDescription = `Calculated total hours (${totalHours}) based on an average AI-generated weight of ${averageWeight.toFixed(
    1
  )}${modifiedDescription} across ${categories.length} categories and ${totalAvailableHours} total available hours.`;

  return { enrichedCategories, totalHours, totalHoursDescription };
};

// API endpoint to calculate weights and provide initial analysis
app.post('/calculate-weight', async (req, res) => {
  const { topic, personalImpact, biasPreference, year, daysPerYear } = req.body;

  try {
    if (!topic || topic.trim().length === 0) {
      return res.status(400).json({ error: 'Topic input is required.' });
    }

    const personalImpactContent = personalImpact && personalImpact.trim()
      ? `The user provided personal relevance: "${personalImpact}."`
      : null;

    const biasPreferenceContent = biasPreference
      ? `The user prefers a ${biasPreference} perspective for this analysis.`
      : `The user prefers a neutral perspective for this analysis.`;

    const yearContent = year
      ? `Focus the analysis on data and context from around the year ${year}.`
      : `Focus the analysis on recent and relevant data.`;

    const daysContent = `The user is willing to spend ${daysPerYear} days per year (${daysPerYear * 24} full hours) on political reasoning, research, and discussion.`;

    const categories = personalImpactContent
      ? 'Statistical Impact, Social Relevance, Policy Impact Potential, and Personal Relevance'
      : 'Statistical Impact, Social Relevance, and Policy Impact Potential';

    const completion = await openai.beta.chat.completions.parse({
      model: 'gpt-4o-2024-11-20',
      response_format: zodResponseFormat(WeightSchema, "weight"),
      messages: [
        {
          role: 'system',
          content:
            `You are a system that evaluates political topics, as relevant to US citizens or visa holders. Your task is to return structured output for the following categories: ${categories}. Err toward two+ sentences per category, or longer sentences per category:
            - Weight: Provide a number between 1 and 10 to indicate the importance of the category. The weights should be relative to the preferred perspective, e.g. a Right-preferring user is less likely to heavily weigh topics like UBI and a Left-preferring user is less likely to heavily weigh topics like the 2nd amendment, while a Centrist would be more balanced.
            - Facts: Provide a list of 5 key facts relevant to the category. Ensure facts are specific and non-empty. Facts should include statistics (percentages, per capita numbers, etc.) when available. Facts should also be distinct from each other, since each one will be fed to an individual search query; i.e., a fact on its own should not require additional context for a search engine to understand.
            - Reasoning: Explain the relevance and significance of the facts to the category. This should be at least a few sentences, terse but not overly so.
            For "Personal Relevance", do not return facts. Output must be in JSON format with keys: "category", "weight", "facts", "reasoning".

            Categories (when present) should be assessed as follows:
            - Statistical Impact: Statistical relevance to the majority of Americans
            - Policy Impact Potential: Consider both legislative options but also non-legislative options, e.g. trans women in women's sports could be solved with league rules rather than legislation.
            - Social Relevance: This score should be based on correcting imbalances, e.g. affirmative action may be weighed higher than protecting girls from trans girls using the bathroom as the former aims to correct imbalances for statistical minorities while the latter is both statistically irrelevant and aims to reduce rights of statistical minorities.

            The array of categories should be wrapped in an outer object under the key "data".`,
        },
        {
          role: 'user',
          content: `Analyze the topic: "${topic}" with the following considerations:\n\n${personalImpactContent || ''}\n${biasPreferenceContent}\n${yearContent}\n${daysContent}\n\nReturn structured output for each category.`,
        },
      ],
    });

    if (!completion.choices || !completion.choices[0] || !completion.choices[0].message.parsed) {
      throw new Error("Invalid response format from OpenAI.");
    }

    const response = completion.choices[0].message.parsed;

    const sortOrder = ["Statistical Impact", "Social Relevance", "Policy Impact Potential", "Personal Relevance"];

    // Sort the data
    response.data.sort((a, b) => {
      return sortOrder.indexOf(a.category) - sortOrder.indexOf(b.category);
    });

    // Resolve sources from Ground.News API in parallel
    const enhanceSources = async (sources) => {
      const apiCalls = sources.map(async (source) => {
        try {
            /*
          const response = await axios.post(
            GROUND_NEWS_API_URL,
            { url: source },
            {
              headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Node.js/Server',
              },
            }
          );
          */
          const response = {data: {}};

          const interest = response.data?.interest;
          return {
            source,
            ground_news_link: interest ? `https://ground.news/interest/${interest.slug}` : ''
          };
        } catch (error) {
          console.error(`Failed to fetch data for source: ${source}`, error.message);
          return { source, ground_news_link: '' };
        }
      });

      return Promise.all(apiCalls);
    };

    // Get real sources
    const enhanceFacts = async (facts) => {
      const apiCalls = facts.map(async (fact) => {
        const sources = await fetchRealSources(fact + ` ${year}`);
        return { fact, sources };
      });

      return Promise.all(apiCalls);
    };

    const citationMap = new Map();
    let citationCounter = 1;

    const enhancedData = await Promise.all(response.data.map(async (category) => {
      const enhancedFacts = await enhanceFacts(category.facts);
      /*
      const enhancedSources = await enhanceSources(enhancedFacts.flatMap(fact => fact.sources));

      enhancedSources.forEach((sourceObj, index) => {
        if (sourceObj.source) {
          const citation = `[${citationCounter}]`;
          citationMap.set(citationCounter, sourceObj);
          sourceObj.citation = citation;
          citationCounter++;
        }
      });
      */

      return {
        ...category,
        facts: enhancedFacts,
      };
    }));

    enhancedData.flatMap(data => data.facts).flatMap(fact => fact.sources).forEach((sourceObj, index) => {
      if (sourceObj.link) {
        const citation = `[${citationCounter}]`;
        citationMap.set(citationCounter, sourceObj);
        sourceObj.citation = citation;
        citationCounter++;
      }
    });

    // Calculate weights and hours
    const { enrichedCategories, totalHours, totalHoursDescription } =
      calculateWeightsAndHours(enhancedData, daysPerYear);


    const combinedSources = Array.from(citationMap.entries()).map(([key, value]) => ({
      citation: `[${key}]`,
      source: value.source,
      ground_news_link: value.ground_news_link,
    }));

    const analysisSummary = `
      ${totalHoursDescription}
      Key Insights: ${response.data.map(w => `${w.category}: ${w.weight}/10`).join(', ')}.
    `;

    res.json({
      weights: enhancedData,
      totalHours: totalHours,
      totalHoursDescription: totalHoursDescription,
      analysisContext: analysisSummary, // Include analysis context for chat
    });
  } catch (error) {
    console.error('Error with OpenAI API:', error.message);
    res.status(500).json({ error: 'Failed to calculate topic weight.' });
  }
});

// API endpoint for chat
app.post('/chat', async (req, res) => {
  const { conversation, analysisContext } = req.body;

  if (!conversation || !Array.isArray(conversation) || !analysisContext) {
    return res.status(400).json({ error: 'Invalid conversation history or analysis context.' });
  }

  try {
    const messages = [
      { role: 'system', content: `You are discussing the topic based on the following analysis: ${analysisContext}` },
      ...conversation,
    ];

    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages,
    });

    const reply = completion.choices[0]?.message?.content || 'Sorry, I couldn’t process your question.';
    res.json({ reply });
  } catch (error) {
    console.error('Error with OpenAI API:', error.message);
    res.status(500).json({ error: 'Failed to process the chat.' });
  }
});

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
