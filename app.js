let DATA = null;
let state = {
  idx: 0,
  answers: [], // {id, correct}
  moduleNeeds: {}, // {moduleId: score}
  // Initialize section scores, ensuring the names exactly match question sections
  sectionCounts: {Foundations: {correct:0,total:0}, Applied: {correct:0,total:0}, Advanced: {correct:0,total:0}, Specialized: {correct:0,total:0}}
};

async function init() {
  // Use exponential backoff for fetch call to data.json
  const maxRetries = 5;
  let res;

  for (let i = 0; i < maxRetries; i++) {
    try {
      res = await fetch('data.json');
      if (res.ok) {
        DATA = await res.json();
        break;
      }
    } catch (error) {
      // Exponential backoff: 2^i * 100ms
      const delay = Math.pow(2, i) * 100;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  if (!DATA) {
    console.error("Failed to load data.json after multiple retries.");
    document.getElementById('welcome').innerHTML = '<h1>Error</h1><p>Failed to load quiz data. Please check the `data.json` file.</p>';
    return;
  }

  document.getElementById('startBtn').addEventListener('click', start);
  document.getElementById('nextBtn').addEventListener('click', next);
  document.getElementById('restartBtn').addEventListener('click', restart);
}

function resetState() {
  state = {
    idx: 0,
    answers: [],
    moduleNeeds: {},
    sectionCounts: {Foundations: {correct:0,total:0}, Applied: {correct:0,total:0}, Advanced: {correct:0,total:0}, Specialized: {correct:0,total:0}}
  };
}

function start() {
  document.getElementById('welcome').classList.add('hidden');
  document.getElementById('quiz').classList.remove('hidden');
  resetState(); // Ensure state is clean on start
  renderQuestion();
}

function restart() {
  document.getElementById('results').classList.add('hidden');
  document.getElementById('welcome').classList.remove('hidden');
  // state will be reset when 'start' is clicked again
}

function renderQuestion() {
  const q = DATA.questions[state.idx];
  document.getElementById('progress').innerText = `Question ${state.idx+1} of ${DATA.questions.length} — ${q.section}`;
  document.getElementById('question').innerText = q.question;
  const choicesEl = document.getElementById('choices');
  choicesEl.innerHTML = '';
  document.getElementById('feedback').classList.add('hidden');
  document.getElementById('nextBtn').classList.add('hidden');

  q.choices.forEach((c) => {
    const btn = document.createElement('button');
    btn.innerText = c.text;
    // Add custom class for styling choices
    btn.classList.add('choice-button');
    btn.addEventListener('click', () => grade(q, c, btn));
    choicesEl.appendChild(btn);
  });
}

function grade(q, choice, clickedButton) {
  const correct = !!choice.isCorrect;
  state.answers.push({ id: q.id, correct });

  // Section score update
  // The 'Specialized' section is treated like other sections for total/correct counts
  state.sectionCounts[q.section].total += 1;
  if (correct) {
    state.sectionCounts[q.section].correct += 1;
  }

  // Module need scoring: ONLY on wrong answers, using weight.
  if (!correct) {
    const weight = q.anchor ? DATA.config.anchorWeight : DATA.config.nonAnchorWeight;
    // q.tags must contain module IDs (numbers)
    q.tags.forEach(mId => {
      // mId in state.moduleNeeds is stored as a string key
      state.moduleNeeds[String(mId)] = (state.moduleNeeds[String(mId)] || 0) + weight;
    });
  }

  // Visual feedback
  const choicesEl = document.getElementById('choices').children;
  [...choicesEl].forEach(btn => {
    const isCorrectChoice = q.choices.find(c => c.text === btn.innerText)?.isCorrect;
    btn.classList.add(isCorrectChoice ? 'correct' : 'incorrect');
    btn.disabled = true;
    // Highlight the user's choice separately if it was incorrect
    if (btn === clickedButton && !correct) {
       btn.classList.add('user-selected-incorrect');
    }
  });

  const fbEl = document.getElementById('feedback');
  fbEl.innerHTML = `<strong>Feedback:</strong> ${correct ? q.feedbackCorrect : q.feedbackIncorrect}`;
  fbEl.classList.remove('hidden');
  document.getElementById('nextBtn').classList.remove('hidden');
}

function next() {
  state.idx += 1;
  if (state.idx >= DATA.questions.length) return finish();
  renderQuestion();
}

function finish() {
  document.getElementById('quiz').classList.add('hidden');
  document.getElementById('results').classList.remove('hidden');

  // Compute section percentages
  const sections = state.sectionCounts;
  const pct = s => s.total ? (s.correct / s.total) : 0;
  const foundationsPct = pct(sections.Foundations);
  const appliedPct = pct(sections.Applied);
  const advancedPct = pct(sections.Advanced);

  // Determine which series to recommend based on thresholds
  const cfg = DATA.config;
  const seriesToConsider = [];

  // Note: The original requirement uses 'Foundations', 'Applied', 'Advanced' for thresholds,
  // which map to 'Basic', 'Advanced', and 'AI/Specialized' modules respectively.
  if (foundationsPct < cfg.sectionThresholds.foundations) seriesToConsider.push('Basic');
  if (appliedPct    < cfg.sectionThresholds.applied)    seriesToConsider.push('Advanced');
  if (advancedPct   < cfg.sectionThresholds.advanced)   seriesToConsider.push('AI/Specialized');

  // --- Module Recommendations (Need Scoring) ---
  // 1. Sort all modules by 'need' score (descending)
  const sortedNeeds = Object.entries(state.moduleNeeds).sort((a,b) => b[1]-a[1]);
  const moduleMap = new Map(DATA.meta.modules.map(m => [String(m.id), m]));
  
  let primaryRecommendations = [];
  let secondaryRecommendations = [];
  let currentPrimaryCount = 0;
  
  // 2. Filter modules based on the series that dropped below the threshold
  sortedNeeds.forEach(([id, score]) => {
      const module = moduleMap.get(id);
      
      // Determine the module's primary series type for filtering
      const moduleSeriesType = module.series === 'AI' ? 'AI/Specialized' : module.series;
      
      if (seriesToConsider.includes(moduleSeriesType)) {
          if (currentPrimaryCount < cfg.maxRecommendationsPerSeries) {
              // Primary: Take the top N (maxRecommendationsPerSeries) overall modules that belong to a failed series
              primaryRecommendations.push({...module, score});
              currentPrimaryCount++;
          } else if (secondaryRecommendations.length < cfg.maxRecommendationsPerSeries) {
              // Secondary: Take the next N overall
              secondaryRecommendations.push({...module, score});
          }
      }
  });

  // Ensure AI 101 (Module 11) is *always* included if the AI/Specialized path is suggested
  const ai101Id = String(cfg.alwaysStartAIAt);
  const ai101 = moduleMap.get(ai101Id);
  
  const isAIRecommended = seriesToConsider.includes('AI/Specialized');
  const hasAI101InPrimary = primaryRecommendations.some(m => String(m.id) === ai101Id);
  const hasAI101InSecondary = secondaryRecommendations.some(m => String(m.id) === ai101Id);

  // If AI is needed and AI 101 isn't already primary/secondary, add it as a separate, mandatory entry.
  let mandatoryAI = isAIRecommended && !hasAI101InPrimary && !hasAI101InSecondary ? ai101 : null;
  
  // If AI 101 is already in primary, remove the duplicates from secondary
  if (hasAI101InPrimary) {
      secondaryRecommendations = secondaryRecommendations.filter(m => String(m.id) !== ai101Id);
  }
  
  // If AI 101 is already in secondary, remove it from mandatory AI list
  if (hasAI101InSecondary) {
      mandatoryAI = null;
  }
  
  // --- Archetype Selection ---
  // Determine which module appeared most in the primary recommendations (by ID mapping)
  const primaryModuleIds = primaryRecommendations.map(m => m.id);
  const allRecommendedModuleIds = [...primaryModuleIds, ...secondaryRecommendations.map(m => m.id)];
  if (mandatoryAI) allRecommendedModuleIds.push(mandatoryAI.id);
  
  const archetype = pickArchetype(allRecommendedModuleIds);
  
  // --- Rendering ---
  const scoresEl = document.getElementById('scores');
  scoresEl.innerHTML = `
    <div class="score-grid">
      <div class="card score-card">
        <span class="badge">Foundations</span>
        <div class="score-pct">${(foundationsPct*100).toFixed(0)}%</div>
      </div>
      <div class="card score-card">
        <span class="badge">Applied Knowledge</span>
        <div class="score-pct">${(appliedPct*100).toFixed(0)}%</div>
      </div>
      <div class="card score-card">
        <span class="badge">Advanced Skills</span>
        <div class="score-pct">${(advancedPct*100).toFixed(0)}%</div>
      </div>
    </div>
  `;

  const recEl = document.getElementById('recommendations');
  let recHtml = '<div class="card rec-card">';
  recHtml += '<h3>Primary Focus (Top 3)</h3>';
  
  if (primaryRecommendations.length === 0 && !mandatoryAI) {
      // If no weaknesses, suggest the highest-scoring modules for fun or AI 101
      if (advancedPct >= cfg.sectionThresholds.advanced) {
           recHtml += '<p>You aced it! You seem ready for the <strong>AI Series</strong> (Module 11) or can choose any specialized module you like!</p>';
           mandatoryAI = ai101;
      } else {
           recHtml += '<p>You performed well across all sections. Here are modules with the highest need score:</p>';
           // Fallback: Show top 3 by raw need score, even if above threshold
           const fallbackPrimary = sortedNeeds.slice(0, cfg.maxRecommendationsPerSeries).map(([id,score]) => ({...moduleMap.get(id), score}));
           recHtml += fallbackPrimary.map(m => `<span class="module-item">• ${m.name}</span>`).join('');
      }
  } else {
      recHtml += primaryRecommendations.map(m => `<span class="module-item">• ${m.name}</span>`).join('');
  }

  if (mandatoryAI) {
      recHtml += '<h3 class="mt-4">Mandatory Starting Point</h3>';
      recHtml += `<span class="module-item ai-module">• ${mandatoryAI.name} (AI Series Entry)</span>`;
  }
  
  if (secondaryRecommendations.length > 0) {
      recHtml += '<h3 class="mt-4">Also Consider</h3>';
      recHtml += secondaryRecommendations.map(m => `<span class="module-item secondary-item">• ${m.name}</span>`).join('');
  }
  
  recHtml += '</div>';
  recEl.innerHTML = recHtml;


  const archEl = document.getElementById('archetype');
  archEl.innerHTML = `
    <div class="card archetype-card">
      <h3 class="mythic-tone">Your Digital Path Revealed</h3>
      <strong class="archetype-label">${archetype.label}</strong>
      <p class="archetype-desc">${archetype.description}</p>
      <p class="archetype-note">This archetype guides your journey through our learning system.</p>
    </div>
  `;
}

function pickArchetype(allRecommendedModuleIds) {
  const arcs = DATA.meta.archetypes;
  // Map module IDs to their respective archetypes. The first match wins.
  
  // We prioritize the most recommended modules by checking against the list of ALL recommended IDs.
  for (const moduleId of allRecommendedModuleIds) {
      // Find the first archetype that maps to this module ID
      const matchingArchetype = arcs.find(a => a.mapsTo.includes(moduleId));
      if (matchingArchetype) {
          return matchingArchetype;
      }
  }
  
  // Fallback: If no weaknesses were found (likely a perfect score or all scores are very low)
  // Default to the most advanced path (Asker of Why) or the first archetype.
  const askerOfWhy = arcs.find(a => a.id === 'asker-of-why');
  return askerOfWhy || arcs[0];
}

window.addEventListener('DOMContentLoaded', init);
