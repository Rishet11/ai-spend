const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { spawnSync } = require('child_process');

const MODEL_PRICING = {
  // Codex Primary Models (Mapped to GPT-4o equivalent API costs)
  'gpt-5.3-codex': { input: 2.50 / 1e6, cacheRead: 1.25 / 1e6, output: 10.00 / 1e6 },
  'gpt-5.2-codex': { input: 2.50 / 1e6, cacheRead: 1.25 / 1e6, output: 10.00 / 1e6 },
  'gpt-5.1-codex-max': { input: 2.50 / 1e6, cacheRead: 1.25 / 1e6, output: 10.00 / 1e6 },
  'gpt-5.2': { input: 2.50 / 1e6, cacheRead: 1.25 / 1e6, output: 10.00 / 1e6 },
  
  // Codex Mini Model (Mapped to GPT-4o-Mini equivalent API costs)
  'gpt-5.1-codex-mini': { input: 0.150 / 1e6, cacheRead: 0.075 / 1e6, output: 0.600 / 1e6 },
};

// Fallback is standard GPT-4o pricing for unknown codex models
const DEFAULT_PRICING = MODEL_PRICING['gpt-5.3-codex'];

function getPricing(model) {
  if (!model) return DEFAULT_PRICING;
  const m = model.toLowerCase();
  
  if (m.includes('mini')) return MODEL_PRICING['gpt-5.1-codex-mini'];
  if (m.includes('5.3')) return MODEL_PRICING['gpt-5.3-codex'];
  if (m.includes('5.2-codex')) return MODEL_PRICING['gpt-5.2-codex'];
  if (m.includes('5.1-codex-max')) return MODEL_PRICING['gpt-5.1-codex-max'];
  if (m.includes('5.2')) return MODEL_PRICING['gpt-5.2'];
  
  return DEFAULT_PRICING;
}

function getCodexDir() {
  return path.join(os.homedir(), '.codex');
}

function q(sql) {
  const dbPath = path.join(getCodexDir(), 'state_5.sqlite');
  try {
    const r = spawnSync("sqlite3", ["-json", dbPath, sql], { encoding: "utf8" });
    if (r.error) throw r.error;
    const out = r.stdout.trim();
    return out ? JSON.parse(out) : [];
  } catch (e) {
    return [];
  }
}

async function parseJSONLFile(filePath) {
  const lines = [];
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }
  return lines;
}

function extractSessionData(entries) {
  const queries = [];
  let pendingPrompt = null;
  let continuations = 0;
  
  let baselineTotalInput = 0;
  let baselineTotalOutput = 0;
  let baselineTotalCached = 0;
  let baselineReasoningOutput = 0;

  let currentTotalInput = 0;
  let currentTotalOutput = 0;
  let currentTotalCached = 0;
  let currentReasoningOutput = 0;

  let currentModel = null;

  let lastSeenInput = 0;
  let lastSeenOutput = 0;

  for (const row of entries) {
    if (row.type === "turn_context" && row.payload?.model) {
      currentModel = row.payload.model;
    }

    if (row.type === "event_msg" && row.payload?.type === "token_count" && row.payload?.info?.total_token_usage) {
      const u = row.payload.info.total_token_usage;
      currentTotalInput = u.input_tokens || 0;
      currentTotalOutput = u.output_tokens || 0;
      currentTotalCached = u.cached_input_tokens || 0;
      currentReasoningOutput = u.reasoning_output_tokens || 0;
    }

    if (row.type === "response_item" && row.payload?.type === "message" && row.payload?.role === "user") {
      if (pendingPrompt !== null) {
        const diffInput = currentTotalInput - baselineTotalInput;
        const diffOutput = currentTotalOutput - baselineTotalOutput;
        const diffCached = currentTotalCached - baselineTotalCached;
        const diffReasoning = currentReasoningOutput - baselineReasoningOutput;

        if (diffInput > 0 || diffOutput > 0) {
          queries.push({
            userPrompt: pendingPrompt,
            model: currentModel,
            inputTokens: diffInput,
            outputTokens: diffOutput,
            cachedTokens: diffCached,
            reasoningTokens: diffReasoning,
            totalTokens: diffInput + diffOutput,
            continuations: Math.max(0, continuations - 1)
          });
        }
      }

      const texts = (row.payload.content || []).filter(c => c.type === 'input_text' || c.type === 'text');
      pendingPrompt = texts.length > 0 ? texts.map(c => c.text).join('\n').trim() : "(No Prompt)";
      
      continuations = 0;
      baselineTotalInput = currentTotalInput;
      baselineTotalOutput = currentTotalOutput;
      baselineTotalCached = currentTotalCached;
      baselineReasoningOutput = currentReasoningOutput;
      
      lastSeenInput = 0;
      lastSeenOutput = 0;
    }
    
    // We still track last_token_usage deduplication just to count how many API calls were made ("continuations")
    if (row.type === "event_msg" && row.payload?.type === "token_count" && row.payload?.info?.last_token_usage) {
      const usage = row.payload.info.last_token_usage;
      const inTok = usage.input_tokens || 0;
      const outTok = usage.output_tokens || 0;
      
      if (inTok !== lastSeenInput || outTok !== lastSeenOutput) {
         lastSeenInput = inTok;
         lastSeenOutput = outTok;
         continuations++;
      }
    }
  }

  if (pendingPrompt !== null) {
    const diffInput = currentTotalInput - baselineTotalInput;
    const diffOutput = currentTotalOutput - baselineTotalOutput;
    const diffCached = currentTotalCached - baselineTotalCached;
    const diffReasoning = currentReasoningOutput - baselineReasoningOutput;

    if (diffInput > 0 || diffOutput > 0) {
      queries.push({
        userPrompt: pendingPrompt,
        model: currentModel,
        inputTokens: diffInput,
        outputTokens: diffOutput,
        cachedTokens: diffCached,
        reasoningTokens: diffReasoning,
        totalTokens: diffInput + diffOutput,
        continuations: Math.max(0, continuations - 1)
      });
    }
  }

  return queries;
}

async function parseAllSessions() {
  const codexDir = getCodexDir();
  const dbPath = path.join(codexDir, 'state_5.sqlite');
  
  if (!fs.existsSync(dbPath)) {
    return { sessions: [], totals: {} };
  }

  // Get all threads from sqlite as the base truth
  const threads = q(`
    SELECT id, rollout_path, created_at, model_provider, title, tokens_used, cwd
    FROM threads
    ORDER BY tokens_used DESC
  `);

  const sessions = [];
  
  const dailyMap = {};
  const modelMap = {};
  const allPrompts = [];

  for (const t of threads) {
    if (!t.rollout_path || !fs.existsSync(t.rollout_path)) continue;
    
    const entries = await parseJSONLFile(t.rollout_path);
    const queries = extractSessionData(entries);
    

    const totalCacheRead = queries.reduce((sum, q) => sum + (q.cachedTokens || 0), 0);
    const totalInput = queries.reduce((sum, q) => sum + (q.inputTokens || 0), 0);
    const totalOutput = queries.reduce((sum, q) => sum + (q.outputTokens || 0), 0);
    const totalReasoning = queries.reduce((sum, q) => sum + (q.reasoningTokens || 0), 0);
    const date = new Date(t.created_at * 1000).toISOString().split('T')[0];
    
    // Pick the most recent/predominant model from queries or fallback to sqlite provider
    const model = queries.length > 0 && queries[queries.length - 1].model ? queries[queries.length - 1].model : (t.model_provider || "unknown");
    const pricing = getPricing(model);
    const totalTokens = totalInput + totalOutput;
    
    const uncachedInput = Math.max(0, totalInput - totalCacheRead);
    const sessionCost = (uncachedInput * pricing.input) + (totalCacheRead * pricing.cacheRead) + (totalOutput * pricing.output);

    sessions.push({
      sessionId: t.id,
      firstPrompt: t.title || "Untitled",
      project: t.cwd,
      date: date,
      model: model,
      queryCount: queries.length,
      queries: queries,
      totalTokens: totalTokens,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cachedTokens: totalCacheRead,
      reasoningTokens: totalReasoning,
      cost: sessionCost
    });
    
    // Process Daily Usage
    if (!dailyMap[date]) {
        dailyMap[date] = { date, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, totalTokens: 0, cost: 0, sessions: 0, queries: 0 };
    }
    dailyMap[date].inputTokens += totalInput;
    dailyMap[date].outputTokens += totalOutput;
    dailyMap[date].cacheReadTokens += totalCacheRead;
    dailyMap[date].reasoningTokens += totalReasoning;
    dailyMap[date].totalTokens += totalTokens;
    dailyMap[date].cost += sessionCost;
    dailyMap[date].sessions += 1;
    dailyMap[date].queries += queries.length;

    // Process Model Stats and Top Prompts per-query accurately
    for (const q of queries) {
        const qModel = q.model || model; // fall back to session model
        if (!modelMap[qModel]) {
            modelMap[qModel] = { model: qModel, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, totalTokens: 0, cost: 0, queryCount: 0 };
        }
        
        const qPricing = getPricing(qModel);
        const qUncached = Math.max(0, q.inputTokens - q.cachedTokens);
        const qCost = (qUncached * qPricing.input) + (q.cachedTokens * qPricing.cacheRead) + (q.outputTokens * qPricing.output);
        
        modelMap[qModel].inputTokens += q.inputTokens;
        modelMap[qModel].outputTokens += q.outputTokens;
        modelMap[qModel].cacheReadTokens += q.cachedTokens;
        modelMap[qModel].reasoningTokens += (q.reasoningTokens || 0);
        modelMap[qModel].totalTokens += q.totalTokens;
        modelMap[qModel].cost += qCost;
        modelMap[qModel].queryCount += 1;

        if (q.totalTokens > 0) {
            allPrompts.push({
                prompt: q.userPrompt || "(No Prompt)",
                inputTokens: q.inputTokens,
                outputTokens: q.outputTokens,
                cacheReadTokens: q.cachedTokens,
                reasoningTokens: q.reasoningTokens || 0,
                totalTokens: q.totalTokens,
                cost: qCost,
                date: date,
                sessionId: t.id,
                model: qModel,
            });
        }
    }
  }

  const dailyUsage = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));
  const modelBreakdown = Object.values(modelMap);
  
  allPrompts.sort((a, b) => b.totalTokens - a.totalTokens);
  const topPrompts = allPrompts.slice(0, 20);

  // Build per-project aggregation
  const projectMap = {};
  for (const session of sessions) {
    const proj = session.project || 'unknown';
    if (!projectMap[proj]) {
      projectMap[proj] = {
        project: proj,
        inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0,
        sessionCount: 0, queryCount: 0,
        modelMap: {},
        allPrompts: [],
      };
    }
    const p = projectMap[proj];
    p.inputTokens += session.inputTokens;
    p.outputTokens += session.outputTokens;
    p.totalTokens += session.totalTokens;
    p.cost += session.cost;
    p.sessionCount += 1;
    p.queryCount += session.queryCount;

    for (const q of session.queries) {
      if (q.model === '<synthetic>' || q.model === 'unknown') continue;
      if (!p.modelMap[q.model]) {
        p.modelMap[q.model] = { model: q.model, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, queryCount: 0 };
      }
      const m = p.modelMap[q.model];
      m.inputTokens += q.inputTokens;
      m.outputTokens += q.outputTokens;
      m.totalTokens += q.totalTokens;
      m.queryCount += 1;
    }

    let curPrompt = null, curInput = 0, curOutput = 0, curConts = 0;
    let curModels = {};
    const flushProjectPrompt = () => {
      if (curPrompt && (curInput + curOutput) > 0) {
        const topModel = Object.entries(curModels).sort((a, b) => b[1] - a[1])[0]?.[0] || session.model;
        p.allPrompts.push({
          prompt: curPrompt.substring(0, 300),
          inputTokens: curInput,
          outputTokens: curOutput,
          totalTokens: curInput + curOutput,
          continuations: curConts,
          model: topModel,
          date: session.date,
          sessionId: session.sessionId,
        });
      }
    };
    for (const q of session.queries) {
      if (q.userPrompt && q.userPrompt !== curPrompt) {
        flushProjectPrompt();
        curPrompt = q.userPrompt;
        curInput = 0; curOutput = 0; curConts = 0;
        curModels = {};
      } else if (!q.userPrompt) {
        curConts++;
      }
      curInput += q.inputTokens;
      curOutput += q.outputTokens;
    }
    flushProjectPrompt();
  }

  const projectBreakdown = Object.values(projectMap).map(p => ({
    project: p.project,
    inputTokens: p.inputTokens,
    outputTokens: p.outputTokens,
    totalTokens: p.totalTokens,
    cost: p.cost,
    sessionCount: p.sessionCount,
    queryCount: p.queryCount,
    modelBreakdown: Object.values(p.modelMap).sort((a, b) => b.totalTokens - a.totalTokens),
    topPrompts: (p.allPrompts || []).sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 10),
  })).sort((a, b) => b.totalTokens - a.totalTokens);

  const totals = {
    totalSessions: sessions.length,
    totalTokens: sessions.reduce((s, c) => s + c.totalTokens, 0),
    totalQueries: sessions.reduce((s, c) => s + c.queryCount, 0),
    totalCacheReadTokens: sessions.reduce((s, c) => s + c.cachedTokens, 0),
    totalInputTokens: sessions.reduce((s, c) => s + c.inputTokens, 0),
    totalOutputTokens: sessions.reduce((s, c) => s + c.outputTokens, 0),
    totalReasoningTokens: sessions.reduce((s, c) => s + (c.reasoningTokens || 0), 0),
    dateRange: dailyUsage.length > 0
      ? { from: dailyUsage[0].date, to: dailyUsage[dailyUsage.length - 1].date }
      : null,
  };
  
  const totalUncachedInput = Math.max(0, totals.totalInputTokens - totals.totalCacheReadTokens);
  totals.totalCost = sessions.reduce((sum, s) => sum + s.cost, 0);
  totals.cacheHitRate = totals.totalInputTokens > 0 ? (totals.totalCacheReadTokens / totals.totalInputTokens) : 0;
  totals.avgTokensPerSession = totals.totalSessions > 0 ? Math.round(totals.totalTokens / totals.totalSessions) : 0;

  const insights = generateInsights(sessions, allPrompts, totals);

  return {
    sessions,
    dailyUsage,
    modelBreakdown,
    topPrompts,
    totals,
    projectBreakdown,
    insights: insights
  };
}

function generateInsights(sessions, allPrompts, totals) {
  const insights = [];

  function fmt(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 10_000) return (n / 1_000).toFixed(0) + 'K';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return n.toLocaleString();
  }

  // 1. Long conversations getting more expensive over time
  const longSessions = sessions.filter(s => s.queries.length > 50);
  if (longSessions.length > 0) {
    const growthData = longSessions.map(s => {
      const first5 = s.queries.slice(0, 5).reduce((sum, q) => sum + q.totalTokens, 0) / Math.min(5, s.queries.length);
      const last5 = s.queries.slice(-5).reduce((sum, q) => sum + q.totalTokens, 0) / Math.min(5, s.queries.length);
      return { session: s, first5, last5, ratio: last5 / Math.max(first5, 1) };
    }).filter(g => g.ratio > 2);

    if (growthData.length > 0) {
      const avgGrowth = (growthData.reduce((s, g) => s + g.ratio, 0) / growthData.length).toFixed(1);
      const worstSession = growthData.sort((a, b) => b.ratio - a.ratio)[0];
      insights.push({
        id: 'context-growth',
        type: 'warning',
        title: 'The longer you chat, the more each message costs',
        description: `In ${growthData.length} of your conversations, the messages near the end cost ${avgGrowth}x more than the ones at the start. Why? Every time you send a message, Codex re-reads the entire conversation from the beginning. So message #5 is cheap, but message #80 is expensive because Codex is re-reading 79 previous messages plus all the code it wrote. Your longest conversation ("${worstSession.session.firstPrompt.substring(0, 50)}...") grew ${worstSession.ratio.toFixed(1)}x more expensive by the end.`,
        action: 'Start a fresh conversation when you move to a new task. If you need context from before, paste a short summary in your first message. This gives Codex a clean slate instead of re-reading hundreds of old messages.',
      });
    }
  }

  // 2. Marathon conversations
  const turnCounts = sessions.map(s => s.queryCount);
  const medianTurns = turnCounts.length > 0 ? (turnCounts.sort((a, b) => a - b)[Math.floor(turnCounts.length / 2)] || 0) : 0;
  const longCount = sessions.filter(s => s.queryCount > 150).length;
  if (longCount >= 1) {
    const longTokens = sessions.filter(s => s.queryCount > 150).reduce((s, ses) => s + ses.totalTokens, 0);
    const longPct = ((longTokens / Math.max(totals.totalTokens, 1)) * 100).toFixed(0);
    insights.push({
      id: 'marathon-sessions',
      type: 'info',
      title: `Just ${longCount} long conversations used ${longPct}% of all your tokens`,
      description: `You have ${longCount} conversations with over 150 messages each. These alone consumed ${fmt(longTokens)} tokens -- that's ${longPct}% of everything. Meanwhile, your typical conversation is about ${medianTurns} messages. Long conversations aren't always bad, but they're disproportionately expensive because of how context builds up.`,
      action: 'Try keeping one conversation per task. When a conversation starts drifting into different topics, that is a good time to start a new one.',
    });
  }

  // 3. Most tokens are re-reading, not writing
  if (totals.totalTokens > 0) {
    const outputPct = (totals.totalOutputTokens / totals.totalTokens) * 100;
    if (outputPct < 5) {
      insights.push({
        id: 'input-heavy',
        type: 'info',
        title: `${outputPct.toFixed(1)}% of your tokens are Codex actually writing`,
        description: `Here's something surprising: out of ${fmt(totals.totalTokens)} total tokens, only ${fmt(totals.totalOutputTokens)} are from Codex writing responses. The other ${(100 - outputPct).toFixed(1)}% is Codex re-reading your conversation history, files, and context before each response. This means the biggest factor in token usage isn't how much Codex writes -- it's how long your conversations are.`,
        action: 'Keeping conversations shorter has more impact than asking for shorter answers. A 20-message conversation costs far less than a 200-message one, even if the total output is similar.',
      });
    }
  }

  // 4. Cache efficiency
  if (totals.totalCacheReadTokens > 0) {
    // Estimating blended average prices from the session list
    const avgInputPrice = sessions.length ? sessions.reduce((s, x) => s + getPricing(x.model).input, 0) / sessions.length : DEFAULT_PRICING.input;
    const avgCacheReadPrice = sessions.length ? sessions.reduce((s, x) => s + getPricing(x.model).cacheRead, 0) / sessions.length : DEFAULT_PRICING.cacheRead;
    const saved = totals.totalCacheReadTokens * (avgInputPrice - avgCacheReadPrice);
    const hitRate = (totals.cacheHitRate * 100).toFixed(1);
    const withoutCaching = totals.totalCost + saved;
    insights.push({
      id: 'cache-savings',
      type: 'info',
      title: `Caching saved you an estimated $${saved.toFixed(2)}`,
      description: `Your cache hit rate is ${hitRate}% -- meaning ${hitRate}% of all tokens were served from cache at ~10x lower cost. Without caching, your estimated API-equivalent bill would be $${withoutCaching.toFixed(2)} instead of $${totals.totalCost.toFixed(2)}. Cache reads happen when Codex re-reads parts of the conversation that haven't changed since the last turn.`,
      action: 'Caching works best in longer conversations where context stays stable. Shorter sessions mean less cache reuse but also less context growth. The sweet spot is medium-length focused sessions on a single task.',
    });
  }

  return insights;
}

module.exports = { parseAllSessions };
