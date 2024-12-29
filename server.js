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
  totalHours: z.number(),
  totalHoursDescription: z.string(),
  data: z.array(
    z.object({
      category: z.string(),
      weight: z.number(),
      facts: z.array(z.string()), // Array of fact strings
      sources: z.array(z.string()), // Array of valid URL strings
      reasoning: z.string(),
    })
  )
});

// API endpoint
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

    const daysContent = `The user is willing to spend ${daysPerYear} days per year on political reasoning, research, and discussion. Adjust the analysis so the ratio of hours is reasonable based on this timeframe.`;

    const categories = personalImpactContent
      ? 'Statistical Impact, Policy Impact Potential, Social Relevance, and Personal Relevance'
      : 'Statistical Impact, Policy Impact Potential, and Social Relevance';

    const completion = await openai.beta.chat.completions.parse({
      model: 'gpt-4o-2024-11-20',
      response_format: zodResponseFormat(WeightSchema, "weight"),
      messages: [
        {
          role: 'system',
          content:
            `You are a system that evaluates political topics, as relevant to US citizens or visa holders. Your task is to return structured output for the following categories: ${categories}. Err toward two+ sentences per category, or longer sentences per category:
            - Weight: Provide a number between 1 and 10 to indicate the importance of the category.
            - Facts: Provide a list of 5 key facts relevant to the category. Ensure facts are specific and non-empty. Facts should include statistics (percentages, per capita numbers, etc.) when available.
            - Sources: Provide credible, deep-linked sources for each fact (e.g., articles, reports, or papers, not top-level domains).
            - Reasoning: Explain the relevance and significance of the facts to the category. This should be at least a few sentences, terse but not overly so.
            For "Personal Relevance", do not cite sources and do not return facts. Output must be in JSON format with keys: "category", "weight", "facts", "sources", "reasoning".

            Categories (when present) should be assessed as follows:
            - Statistical Impact: Statistical relevance to the majority of Americans
            - Policy Impact Potential: Consider both legislative options but also non-legislative options, e.g. trans women in women's sports could be solved with league rules rather than legislation.
            - Social Relevance: This score should be based on correcting imbalances, e.g. affirmative action may be weighed higher than protecting girls from trans girls using the bathroom as the former aims to correct imbalances for statistical minorities while the latter is both statistically irrelevant and aims to reduce rights of statistical minorities.

            The array of categories should be wrapped in an outer object under the key "data".

            Finally, the response should include a top-level "totalHours" field that uses an intelligent algorithm that uses all weights to calculate a total number of hours an American should reasonably spend researching, discussing, or considering the topic at hand. A top-level "totalHoursDescription" field should also be included that describes in detail how the hours were calculated based on the given weights. "totalHoursDescription" should detail the exact calculation, not eliding details.`,
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

    // Resolve sources from Ground.News API in parallel
    const enhanceSources = async (sources) => {
      const apiCalls = sources.map(async (source) => {
        try {
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

    const citationMap = new Map();
    let citationCounter = 1;

    const enhancedData = await Promise.all(
      response.data.map(async (category) => {
        const enhancedSources = await enhanceSources(category.sources);

        enhancedSources.forEach((sourceObj, index) => {
          if (sourceObj.source) {
            const citation = `[${citationCounter}]`;
            citationMap.set(citationCounter, sourceObj);
            sourceObj.citation = citation;
            citationCounter++;
          }
        });

        return {
          ...category,
          sources: enhancedSources,
        };
      })
    );

    const combinedSources = Array.from(citationMap.entries()).map(([key, value]) => ({
      citation: `[${key}]`,
      source: value.source,
      ground_news_link: value.ground_news_link,
    }));

    res.json({
      weights: enhancedData,
      totalHours: response.totalHours,
      totalHoursDescription: response.totalHoursDescription,
      sources: combinedSources
    });
  } catch (error) {
    console.error('Error with OpenAI API:', error.message);
    res.status(500).json({ error: 'Failed to calculate topic weight.' });
  }
});

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});

