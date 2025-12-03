import React, { useState, useMemo, useCallback } from 'react';

// GPT-4 tokenizer approximation (cl100k_base patterns)
const approximateTokenize = (text) => {
  if (!text) return [];
  // Simplified BPE-like tokenization
  const tokens = [];
  let remaining = text;
  
  while (remaining.length > 0) {
    // Common patterns get single tokens
    const patterns = [
      /^[\s]+/, // whitespace
      /^[A-Z][a-z]+/, // Capitalized words
      /^[a-z]+/, // lowercase words
      /^[0-9]+/, // numbers
      /^[.,!?;:'"()\[\]{}]/, // punctuation
      /^[^\s\w]/, // special chars
    ];
    
    let matched = false;
    for (const pattern of patterns) {
      const match = remaining.match(pattern);
      if (match) {
        const word = match[0];
        // Long words split into ~4 char chunks (BPE approximation)
        if (word.length > 4 && /^[a-zA-Z]+$/.test(word)) {
          for (let i = 0; i < word.length; i += 4) {
            tokens.push(word.slice(i, Math.min(i + 4, word.length)));
          }
        } else {
          tokens.push(word);
        }
        remaining = remaining.slice(word.length);
        matched = true;
        break;
      }
    }
    if (!matched) {
      tokens.push(remaining[0]);
      remaining = remaining.slice(1);
    }
  }
  return tokens;
};

// Claude tokenizer approximation (slightly different patterns)
const approximateClaudeTokenize = (text) => {
  if (!text) return [];
  const tokens = [];
  let remaining = text;
  
  while (remaining.length > 0) {
    const patterns = [
      /^[\s]+/,
      /^[A-Z][a-z]{0,5}/, // Claude tends to split caps differently
      /^[a-z]{1,5}/, // Shorter word chunks
      /^[0-9]+/,
      /^[.,!?;:'"()\[\]{}]/,
      /^[^\s\w]/,
    ];
    
    let matched = false;
    for (const pattern of patterns) {
      const match = remaining.match(pattern);
      if (match) {
        tokens.push(match[0]);
        remaining = remaining.slice(match[0].length);
        matched = true;
        break;
      }
    }
    if (!matched) {
      tokens.push(remaining[0]);
      remaining = remaining.slice(1);
    }
  }
  return tokens;
};

// Gemini approximation (SentencePiece-like)
const approximateGeminiTokenize = (text) => {
  if (!text) return [];
  const tokens = [];
  let remaining = text;
  
  while (remaining.length > 0) {
    const patterns = [
      /^▁?[A-Za-z]{1,6}/, // SentencePiece underscore prefix
      /^[\s]+/,
      /^[0-9]+/,
      /^[^\s\w]/,
    ];
    
    let matched = false;
    for (const pattern of patterns) {
      const match = remaining.match(pattern);
      if (match) {
        tokens.push(match[0]);
        remaining = remaining.slice(match[0].length);
        matched = true;
        break;
      }
    }
    if (!matched) {
      tokens.push(remaining[0]);
      remaining = remaining.slice(1);
    }
  }
  return tokens;
};

// Entity extraction (basic proper noun detection)
const extractEntities = (text) => {
  const entities = [];
  // Capitalized words not at sentence start
  const matches = text.matchAll(/(?<=[.!?]\s+[^A-Z]*|^[^A-Z]*)([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)/g);
  for (const match of matches) {
    if (match[1] && match[1].length > 2) {
      entities.push({
        text: match[1],
        position: match.index,
      });
    }
  }
  // Also catch ALL CAPS (acronyms, brands)
  const acronyms = text.matchAll(/\b([A-Z]{2,})\b/g);
  for (const match of acronyms) {
    entities.push({
      text: match[1],
      position: match.index,
    });
  }
  return entities;
};

// Calculate attention score based on position within chunk
const getAttentionScore = (positionInChunk, chunkSize) => {
  const normalizedPos = positionInChunk / chunkSize;
  
  // U-shaped curve: high at start, drops in middle, rises at end
  // Based on primacy/recency bias research
  if (normalizedPos < 0.15) {
    return 0.95 - (normalizedPos * 0.5); // First 15%: 95% -> 87.5%
  } else if (normalizedPos > 0.85) {
    return 0.7 + ((normalizedPos - 0.85) * 1.5); // Last 15%: 70% -> 92.5%
  } else {
    // Middle: degraded attention (murky middle)
    const midPoint = 0.5;
    const distFromMid = Math.abs(normalizedPos - midPoint);
    return 0.55 + (distFromMid * 0.3); // 55% at center, up to 70% at edges
  }
};

// Chunk content at specified token boundaries
const chunkContent = (text, tokens, chunkSize) => {
  const chunks = [];
  let currentChunk = [];
  let currentText = '';
  let tokenIndex = 0;
  let charIndex = 0;
  
  for (let i = 0; i < tokens.length; i++) {
    currentChunk.push(tokens[i]);
    currentText += tokens[i];
    
    if (currentChunk.length >= chunkSize || i === tokens.length - 1) {
      chunks.push({
        tokens: [...currentChunk],
        text: currentText,
        startToken: tokenIndex,
        endToken: tokenIndex + currentChunk.length - 1,
        tokenCount: currentChunk.length,
      });
      tokenIndex += currentChunk.length;
      currentChunk = [];
      currentText = '';
    }
  }
  
  return chunks;
};

// Split into paragraphs
const splitParagraphs = (text) => {
  return text.split(/\n\n+/).filter(p => p.trim().length > 0);
};

export default function TokenAnalyzer() {
  const [content, setContent] = useState('');
  const [chunkSize, setChunkSize] = useState(100);
  const [activeTab, setActiveTab] = useState('overview');
  
  const analysis = useMemo(() => {
    if (!content.trim()) return null;
    
    const gptTokens = approximateTokenize(content);
    const claudeTokens = approximateClaudeTokenize(content);
    const geminiTokens = approximateGeminiTokenize(content);
    
    const paragraphs = splitParagraphs(content);
    const paragraphAnalysis = paragraphs.map((p, idx) => {
      const pTokens = approximateTokenize(p);
      return {
        index: idx,
        text: p,
        tokenCount: pTokens.length,
        exceedsChunk: pTokens.length > chunkSize,
        chunksRequired: Math.ceil(pTokens.length / chunkSize),
      };
    });
    
    const chunks = chunkContent(content, gptTokens, chunkSize);
    const entities = extractEntities(content);
    
    // Calculate entity positions relative to tokens
    const entityAnalysis = entities.map(entity => {
      let tokenPosition = 0;
      let charCount = 0;
      for (let i = 0; i < gptTokens.length; i++) {
        if (charCount >= entity.position) {
          tokenPosition = i;
          break;
        }
        charCount += gptTokens[i].length;
      }
      
      const chunkIndex = Math.floor(tokenPosition / chunkSize);
      const positionInChunk = tokenPosition % chunkSize;
      const attention = getAttentionScore(positionInChunk, chunkSize);
      
      return {
        ...entity,
        tokenPosition,
        chunkIndex,
        positionInChunk,
        attentionScore: attention,
        isLowAttention: attention < 0.65,
      };
    });
    
    // Word efficiency
    const wordCount = content.split(/\s+/).filter(w => w.length > 0).length;
    const wordsPerToken = wordCount / gptTokens.length;
    
    return {
      gptTokens: gptTokens.length,
      claudeTokens: claudeTokens.length,
      geminiTokens: geminiTokens.length,
      variance: Math.round(((Math.max(gptTokens.length, claudeTokens.length, geminiTokens.length) - 
                            Math.min(gptTokens.length, claudeTokens.length, geminiTokens.length)) / 
                           gptTokens.length) * 100),
      paragraphs: paragraphAnalysis,
      chunks,
      entities: entityAnalysis,
      wordCount,
      wordsPerToken: wordsPerToken.toFixed(3),
      efficiency: wordsPerToken >= 0.75 ? 'optimal' : wordsPerToken >= 0.65 ? 'acceptable' : 'verbose',
    };
  }, [content, chunkSize]);
  
  // Generate optimization hints
  const hints = useMemo(() => {
    if (!analysis) return [];
    const h = [];
    
    // Check for buried value props
    const firstChunkEntities = analysis.entities.filter(e => e.chunkIndex === 0);
    const laterEntities = analysis.entities.filter(e => e.chunkIndex > 0);
    if (laterEntities.length > firstChunkEntities.length) {
      h.push({
        type: 'warning',
        message: `${laterEntities.length} entities appear after chunk 1. Front-load key terms for higher citation probability.`,
      });
    }
    
    // Check for low attention entities
    const lowAttentionEntities = analysis.entities.filter(e => e.isLowAttention);
    if (lowAttentionEntities.length > 0) {
      h.push({
        type: 'critical',
        message: `${lowAttentionEntities.length} entities in low-attention zones (middle of chunks). Consider repositioning: ${lowAttentionEntities.slice(0, 3).map(e => e.text).join(', ')}`,
      });
    }
    
    // Check for paragraphs exceeding chunk size
    const longParagraphs = analysis.paragraphs.filter(p => p.exceedsChunk);
    if (longParagraphs.length > 0) {
      h.push({
        type: 'warning',
        message: `${longParagraphs.length} paragraph(s) exceed ${chunkSize} tokens and will split across multiple chunks.`,
      });
    }
    
    // Check token efficiency
    if (analysis.efficiency === 'verbose') {
      h.push({
        type: 'optimize',
        message: `Token efficiency ${analysis.wordsPerToken} words/token is below optimal (0.75+). Reduce filler words.`,
      });
    }
    
    // Chunk count assessment
    if (analysis.chunks.length > 5) {
      h.push({
        type: 'info',
        message: `Content spans ${analysis.chunks.length} chunks. Position 1 and ${analysis.chunks.length} have highest attention.`,
      });
    }
    
    // Optimal chunk size hint
    if (chunkSize > 120) {
      h.push({
        type: 'optimize',
        message: `Research suggests 90-120 token chunks optimize for LLM attention patterns.`,
      });
    }
    
    return h;
  }, [analysis, chunkSize]);
  
  const getAttentionColor = (score) => {
    if (score >= 0.85) return '#4FD1C5'; // teal - hot
    if (score >= 0.70) return '#38A89D'; // medium teal
    if (score >= 0.60) return '#6B7280'; // gray - degraded
    return '#FF4444'; // red - cold
  };
  
  const getHintIcon = (type) => {
    switch (type) {
      case 'critical': return '⚠';
      case 'warning': return '△';
      case 'optimize': return '⚡';
      default: return 'ℹ';
    }
  };
  
  const getHintColor = (type) => {
    switch (type) {
      case 'critical': return '#FF4444';
      case 'warning': return '#F59E0B';
      case 'optimize': return '#4FD1C5';
      default: return '#6B7280';
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      backgroundColor: '#0D1117',
      color: '#E6EDF3',
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      padding: '24px',
    }}>
      {/* Header */}
      <div style={{ marginBottom: '32px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
          <span style={{ color: '#4FD1C5', fontSize: '24px' }}>▸</span>
          <h1 style={{ 
            margin: 0, 
            fontSize: '24px', 
            fontWeight: 600,
            letterSpacing: '-0.5px',
          }}>
            RAG Token Analyzer
          </h1>
          <span style={{ 
            fontSize: '11px', 
            padding: '2px 8px', 
            backgroundColor: '#1F2937', 
            borderRadius: '4px',
            color: '#4FD1C5',
          }}>
            v1.0
          </span>
        </div>
        <p style={{ 
          margin: 0, 
          fontSize: '13px', 
          color: '#6B7280',
          paddingLeft: '36px',
        }}>
          Analyze content chunking & attention patterns for LLM citation optimization
        </p>
      </div>

      {/* Input Area */}
      <div style={{ marginBottom: '24px' }}>
        <label style={{ 
          display: 'block', 
          marginBottom: '8px', 
          fontSize: '12px',
          color: '#4FD1C5',
          textTransform: 'uppercase',
          letterSpacing: '1px',
        }}>
          Content Input
        </label>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Paste content to analyze..."
          style={{
            width: '100%',
            height: '160px',
            backgroundColor: '#161B22',
            border: '1px solid #30363D',
            borderRadius: '6px',
            padding: '16px',
            color: '#E6EDF3',
            fontFamily: 'inherit',
            fontSize: '13px',
            resize: 'vertical',
            outline: 'none',
          }}
        />
      </div>

      {/* Chunk Size Control */}
      <div style={{ 
        marginBottom: '24px', 
        display: 'flex', 
        alignItems: 'center', 
        gap: '16px',
        flexWrap: 'wrap',
      }}>
        <label style={{ fontSize: '12px', color: '#6B7280' }}>
          Chunk Size:
        </label>
        <div style={{ display: 'flex', gap: '8px' }}>
          {[90, 100, 120, 256, 512].map(size => (
            <button
              key={size}
              onClick={() => setChunkSize(size)}
              style={{
                padding: '6px 12px',
                backgroundColor: chunkSize === size ? '#4FD1C5' : '#1F2937',
                color: chunkSize === size ? '#0D1117' : '#E6EDF3',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '12px',
                fontFamily: 'inherit',
                transition: 'all 0.15s',
              }}
            >
              {size}
            </button>
          ))}
        </div>
        <span style={{ fontSize: '11px', color: '#6B7280' }}>
          {chunkSize <= 120 ? '✓ optimal range' : '△ larger than recommended'}
        </span>
      </div>

      {analysis && (
        <>
          {/* Token Counts */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: '16px',
            marginBottom: '24px',
          }}>
            {[
              { label: 'GPT-4/4o', value: analysis.gptTokens, sub: 'cl100k_base' },
              { label: 'Claude', value: analysis.claudeTokens, sub: 'anthropic' },
              { label: 'Gemini', value: analysis.geminiTokens, sub: 'sentencepiece' },
              { label: 'Variance', value: `±${analysis.variance}%`, sub: 'cross-model' },
            ].map((item, idx) => (
              <div key={idx} style={{
                backgroundColor: '#161B22',
                border: '1px solid #30363D',
                borderRadius: '6px',
                padding: '16px',
              }}>
                <div style={{ fontSize: '11px', color: '#6B7280', marginBottom: '4px' }}>
                  {item.label}
                </div>
                <div style={{ 
                  fontSize: '28px', 
                  fontWeight: 600, 
                  color: '#4FD1C5',
                  lineHeight: 1,
                }}>
                  {item.value}
                </div>
                <div style={{ fontSize: '10px', color: '#4B5563', marginTop: '4px' }}>
                  {item.sub}
                </div>
              </div>
            ))}
          </div>

          {/* Efficiency Badge */}
          <div style={{
            backgroundColor: '#161B22',
            border: '1px solid #30363D',
            borderRadius: '6px',
            padding: '16px',
            marginBottom: '24px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '12px',
          }}>
            <div>
              <span style={{ color: '#6B7280', fontSize: '12px' }}>Token Efficiency: </span>
              <span style={{ 
                color: analysis.efficiency === 'optimal' ? '#4FD1C5' : 
                       analysis.efficiency === 'acceptable' ? '#F59E0B' : '#FF4444',
                fontWeight: 600,
              }}>
                {analysis.wordsPerToken} words/token
              </span>
              <span style={{ 
                marginLeft: '8px',
                padding: '2px 8px',
                backgroundColor: analysis.efficiency === 'optimal' ? '#0D4F4A' : 
                                analysis.efficiency === 'acceptable' ? '#4A3600' : '#4A0000',
                borderRadius: '4px',
                fontSize: '10px',
                textTransform: 'uppercase',
              }}>
                {analysis.efficiency}
              </span>
            </div>
            <div style={{ fontSize: '12px', color: '#6B7280' }}>
              {analysis.wordCount} words · {analysis.chunks.length} chunks
            </div>
          </div>

          {/* Tabs */}
          <div style={{ 
            display: 'flex', 
            gap: '4px', 
            marginBottom: '16px',
            borderBottom: '1px solid #30363D',
            paddingBottom: '8px',
          }}>
            {['overview', 'chunks', 'entities', 'paragraphs'].map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: '8px 16px',
                  backgroundColor: activeTab === tab ? '#1F2937' : 'transparent',
                  color: activeTab === tab ? '#4FD1C5' : '#6B7280',
                  border: 'none',
                  borderRadius: '4px 4px 0 0',
                  cursor: 'pointer',
                  fontSize: '12px',
                  fontFamily: 'inherit',
                  textTransform: 'capitalize',
                }}
              >
                {tab}
              </button>
            ))}
          </div>

          {/* Tab Content */}
          <div style={{
            backgroundColor: '#161B22',
            border: '1px solid #30363D',
            borderRadius: '6px',
            padding: '20px',
            minHeight: '300px',
          }}>
            {activeTab === 'overview' && (
              <div>
                <h3 style={{ 
                  margin: '0 0 16px 0', 
                  fontSize: '14px', 
                  color: '#4FD1C5',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                }}>
                  <span>⚡</span> Optimization Hints
                </h3>
                {hints.length === 0 ? (
                  <div style={{ color: '#4FD1C5', fontSize: '13px' }}>
                    ✓ No critical issues detected
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    {hints.map((hint, idx) => (
                      <div key={idx} style={{
                        display: 'flex',
                        gap: '12px',
                        padding: '12px',
                        backgroundColor: '#0D1117',
                        borderRadius: '4px',
                        borderLeft: `3px solid ${getHintColor(hint.type)}`,
                      }}>
                        <span style={{ color: getHintColor(hint.type) }}>
                          {getHintIcon(hint.type)}
                        </span>
                        <span style={{ fontSize: '13px', lineHeight: 1.5 }}>
                          {hint.message}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                
                {/* Attention Heat Map Legend */}
                <div style={{ marginTop: '24px' }}>
                  <h4 style={{ 
                    margin: '0 0 12px 0', 
                    fontSize: '12px', 
                    color: '#6B7280',
                    textTransform: 'uppercase',
                    letterSpacing: '1px',
                  }}>
                    Attention Decay Model
                  </h4>
                  <div style={{ 
                    display: 'flex', 
                    height: '24px', 
                    borderRadius: '4px', 
                    overflow: 'hidden',
                    marginBottom: '8px',
                  }}>
                    <div style={{ flex: '15%', backgroundColor: '#4FD1C5' }} />
                    <div style={{ flex: '70%', background: 'linear-gradient(90deg, #38A89D, #4B5563, #38A89D)' }} />
                    <div style={{ flex: '15%', backgroundColor: '#4FD1C5' }} />
                  </div>
                  <div style={{ 
                    display: 'flex', 
                    justifyContent: 'space-between',
                    fontSize: '10px',
                    color: '#6B7280',
                  }}>
                    <span>Primacy (95%)</span>
                    <span>Murky Middle (55-70%)</span>
                    <span>Recency (92%)</span>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'chunks' && (
              <div>
                <h3 style={{ margin: '0 0 16px 0', fontSize: '14px', color: '#4FD1C5' }}>
                  Chunk Simulation ({chunkSize} tokens/chunk)
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {analysis.chunks.map((chunk, idx) => (
                    <div key={idx} style={{
                      backgroundColor: '#0D1117',
                      borderRadius: '4px',
                      padding: '12px',
                      borderLeft: idx === 0 || idx === analysis.chunks.length - 1 
                        ? '3px solid #4FD1C5' 
                        : '3px solid #4B5563',
                    }}>
                      <div style={{ 
                        display: 'flex', 
                        justifyContent: 'space-between',
                        marginBottom: '8px',
                        fontSize: '11px',
                      }}>
                        <span style={{ color: '#4FD1C5' }}>
                          Chunk {idx + 1}
                          {(idx === 0 || idx === analysis.chunks.length - 1) && 
                            <span style={{ marginLeft: '8px', color: '#10B981' }}>● HOT ZONE</span>
                          }
                        </span>
                        <span style={{ color: '#6B7280' }}>
                          {chunk.tokenCount} tokens
                        </span>
                      </div>
                      <div style={{ 
                        fontSize: '12px', 
                        color: '#9CA3AF',
                        lineHeight: 1.6,
                        maxHeight: '80px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}>
                        {chunk.text.slice(0, 200)}{chunk.text.length > 200 && '...'}
                      </div>
                      {/* Attention bar for this chunk */}
                      <div style={{ 
                        marginTop: '8px',
                        height: '4px',
                        borderRadius: '2px',
                        display: 'flex',
                        gap: '1px',
                      }}>
                        {Array.from({ length: 20 }).map((_, i) => {
                          const pos = (i / 20) * chunk.tokenCount;
                          const attention = getAttentionScore(pos, chunk.tokenCount);
                          return (
                            <div 
                              key={i}
                              style={{ 
                                flex: 1, 
                                backgroundColor: getAttentionColor(attention),
                                opacity: 0.8,
                              }} 
                            />
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {activeTab === 'entities' && (
              <div>
                <h3 style={{ margin: '0 0 16px 0', fontSize: '14px', color: '#4FD1C5' }}>
                  Entity/Claim Position Analysis
                </h3>
                {analysis.entities.length === 0 ? (
                  <div style={{ color: '#6B7280', fontSize: '13px' }}>
                    No entities detected. Add proper nouns, brand names, or acronyms.
                  </div>
                ) : (
                  <div style={{ 
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                    gap: '12px',
                  }}>
                    {analysis.entities.map((entity, idx) => (
                      <div key={idx} style={{
                        backgroundColor: '#0D1117',
                        borderRadius: '4px',
                        padding: '12px',
                        borderLeft: `3px solid ${getAttentionColor(entity.attentionScore)}`,
                      }}>
                        <div style={{ 
                          fontWeight: 600, 
                          marginBottom: '8px',
                          color: entity.isLowAttention ? '#FF4444' : '#E6EDF3',
                        }}>
                          {entity.text}
                        </div>
                        <div style={{ 
                          fontSize: '11px', 
                          color: '#6B7280',
                          display: 'grid',
                          gridTemplateColumns: '1fr 1fr',
                          gap: '4px',
                        }}>
                          <span>Chunk: {entity.chunkIndex + 1}</span>
                          <span>Token: {entity.tokenPosition}</span>
                          <span>Position: {entity.positionInChunk}/{chunkSize}</span>
                          <span style={{ color: getAttentionColor(entity.attentionScore) }}>
                            Attention: {(entity.attentionScore * 100).toFixed(0)}%
                          </span>
                        </div>
                        {entity.isLowAttention && (
                          <div style={{ 
                            marginTop: '8px',
                            fontSize: '10px',
                            color: '#FF4444',
                            backgroundColor: '#4A0000',
                            padding: '4px 8px',
                            borderRadius: '3px',
                          }}>
                            ⚠ Low attention zone - consider repositioning
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'paragraphs' && (
              <div>
                <h3 style={{ margin: '0 0 16px 0', fontSize: '14px', color: '#4FD1C5' }}>
                  Paragraph Breakdown
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {analysis.paragraphs.map((para, idx) => (
                    <div key={idx} style={{
                      backgroundColor: '#0D1117',
                      borderRadius: '4px',
                      padding: '12px',
                      borderLeft: para.exceedsChunk 
                        ? '3px solid #FF4444' 
                        : '3px solid #30363D',
                    }}>
                      <div style={{ 
                        display: 'flex', 
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: '8px',
                      }}>
                        <span style={{ fontSize: '12px', color: '#6B7280' }}>
                          Paragraph {idx + 1}
                        </span>
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                          <span style={{ 
                            fontSize: '11px',
                            padding: '2px 8px',
                            backgroundColor: para.tokenCount <= chunkSize * 0.9 ? '#0D4F4A' :
                                            para.tokenCount <= chunkSize ? '#4A3600' : '#4A0000',
                            borderRadius: '3px',
                          }}>
                            {para.tokenCount} tokens
                          </span>
                          {para.exceedsChunk && (
                            <span style={{ 
                              fontSize: '10px', 
                              color: '#FF4444',
                            }}>
                              → {para.chunksRequired} chunks
                            </span>
                          )}
                        </div>
                      </div>
                      <div style={{ 
                        fontSize: '12px', 
                        color: '#9CA3AF',
                        lineHeight: 1.5,
                        maxHeight: '60px',
                        overflow: 'hidden',
                      }}>
                        {para.text.slice(0, 150)}{para.text.length > 150 && '...'}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div style={{ 
            marginTop: '24px', 
            paddingTop: '16px',
            borderTop: '1px solid #30363D',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontSize: '11px',
            color: '#4B5563',
          }}>
            <span>
              Token counts are approximations. Actual tokenization varies by model.
            </span>
            <a 
              href="https://pixeloni.ai" 
              target="_blank" 
              rel="noopener noreferrer"
              style={{ 
                color: '#4FD1C5', 
                textDecoration: 'none',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
              }}
            >
              PixelOni.ai →
            </a>
          </div>
        </>
      )}
    </div>
  );
}
