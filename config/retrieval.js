// ============================================================================
// chat-optimization-v2 in-browser RAG retriever.
// BM25 lexical retrieval: pure logic, no DOM, no model loading.
// Chinese text is tokenized as character unigrams + bigrams (no dictionary),
// so short queries and phrase fragments still overlap.
// ============================================================================
(function () {
    'use strict';

    const NS = window.ChatOptimizationV2 = window.ChatOptimizationV2 || {};

    const BM25_K1 = 1.5;
    const BM25_B = 0.75;
    const DEFAULT_TOP_K = 6;
    // 常见虚词单字：只过滤单字形态，包含它们的 bigram 照常产出（如"在校"保留）
    // 不/没/有 等承载语义（否定、存在）的字不过滤
    const STOP_UNI = new Set('的了着在和与及或是等都就还又很太更最被把让向对从到为之其此该这那它我你他她吗吧啊呀嘛呢么'.split(''));

    /**
     * 轻量分词（无需词典）：
     * - 中文连续片段：单字（停用虚词除外）+ 双字（bigram，不过滤），单字符片段只出单字
     * - 英文/数字：整词（小写，保留内部 . _ - 连接的形态，如 3.14）
     * 其余字符（标点、空白）丢弃。
     * @param {string} text
     * @returns {string[]}
     */
    function tokenize(text) {
        const tokens = [];
        const normalized = String(text || '').toLowerCase();
        const re = /([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+)|([a-z0-9]+(?:[._-][a-z0-9]+)*)/g;
        let m;
        while ((m = re.exec(normalized)) !== null) {
            if (m[1] !== undefined) {
                const run = m[1];
                for (let i = 0; i < run.length; i++) {
                    const ch = run[i];
                    if (!STOP_UNI.has(ch)) tokens.push(ch);
                }
                for (let i = 0; i + 1 < run.length; i++) {
                    tokens.push(run.slice(i, i + 2));
                }
            } else {
                tokens.push(m[2]);
            }
        }
        return tokens;
    }

    /**
     * 对 docs 做 BM25 topK 检索。
     * 每次调用对传入 docs 现建倒排统计（远端条目集合每次生成都不同，不缓存）。
     * @param {string} query - 查询文本（用户消息或历程条目文本）
     * @param {Array<string|{text: string}>} docs - 候选文档
     * @param {number} topK
     * @param {number} minScore - BM25 得分阈值（无归一化，0 表示取所有有词项命中的文档）
     * @returns {Promise<Array<{index: number, text: string, score: number}>>}
     */
    async function retrieve(query, docs, topK = DEFAULT_TOP_K, minScore = 0) {
        if (!query || !Array.isArray(docs) || docs.length === 0) return [];
        const docTexts = docs.map(d => (typeof d === 'string' ? d : (d && d.text) || ''))
            .map(t => String(t).trim()).filter(t => t !== '');
        if (docTexts.length === 0) return [];

        const queryTokens = tokenize(query);
        if (queryTokens.length === 0) return [];

        const queryTf = new Map();
        for (const t of queryTokens) queryTf.set(t, (queryTf.get(t) || 0) + 1);

        const docTokens = docTexts.map(tokenize);
        const docLens = docTokens.map(t => t.length);
        const avgdl = docLens.length > 0
            ? docLens.reduce((a, b) => a + b, 0) / docLens.length
            : 0;

        const df = new Map();
        for (const toks of docTokens) {
            const seen = new Set(toks);
            for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
        }

        const N = docTokens.length;
        const results = [];
        for (let i = 0; i < N; i++) {
            const tf = new Map();
            for (const t of docTokens[i]) tf.set(t, (tf.get(t) || 0) + 1);

            let score = 0;
            for (const [term, qf] of queryTf) {
                const f = tf.get(term);
                if (!f) continue;
                const d = df.get(term) || 0;
                const idf = Math.log(1 + (N - d + 0.5) / (d + 0.5));
                const denom = f + BM25_K1 * (1 - BM25_B + BM25_B * (avgdl > 0 ? docLens[i] / avgdl : 1));
                score += idf * (qf * (BM25_K1 + 1)) / denom;
            }
            if (score > (minScore || 0)) {
                results.push({ index: i, text: docTexts[i], score });
            }
        }
        results.sort((a, b) => b.score - a.score);
        return results.slice(0, topK);
    }

    NS.Retriever = Object.freeze({
        isReady: () => true,
        retrieve,
        tokenize,
    });
})();
