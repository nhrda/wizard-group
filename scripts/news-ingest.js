/*
 * Ingesta independiente de noticias. No lee ni escribe wizardgroup/estado.
 * Prioridad de fuentes: RSS/XML, datos estructurados JSON-LD y HTML de portada.
 */
const crypto = require('crypto');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

const HOURS_WINDOW = 48;
const RETENTION_DAYS = 30;
const MAX_NEW_PER_RUN = 8;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const NOW = new Date();

initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = getFirestore();

const SOURCES = [
  {
    id: '100seguro', name: '100% SEGURO', url: 'https://100seguro.com.ar/',
    feeds: ['https://100seguro.com.ar/feed/', 'https://100seguro.com.ar/feed/?post_type=post'],
    extract: extract100Seguro
  },
  {
    id: 'tiempo-seguros', name: 'Tiempo de Seguros', url: 'https://www.tiempodeseguros.com.ar/',
    feeds: ['https://www.tiempodeseguros.com.ar/feed/', 'https://www.tiempodeseguros.com.ar/?format=feed'],
    extract: extractTiempoDeSeguros
  },
  {
    id: 'revista-seguros-aapas', name: 'Revista Seguros AAPAS', url: 'https://revistaseguros.aapas.org.ar/',
    feeds: ['https://revistaseguros.aapas.org.ar/feed/', 'https://revistaseguros.aapas.org.ar/?feed=rss2'],
    extract: extractRevistaAAPAS
  }
];

function log(message, extra) { console.log(`[news] ${message}`, extra || ''); }
function decodeHtml(value = '') {
  return String(value).replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#8217;|&#039;/gi, "'").replace(/&#8211;|&#8212;/gi, '—')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ').trim();
}
function normalizeUrl(value) {
  try {
    const url = new URL(decodeHtml(value));
    ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','fbclid','gclid'].forEach(key => url.searchParams.delete(key));
    url.hash = '';
    url.pathname = url.pathname.replace(/\/$/, '') || '/';
    return url.toString();
  } catch { return ''; }
}
function articleId(url) { return crypto.createHash('sha256').update(url).digest('hex').slice(0, 40); }
function normalizedTitle(title) { return decodeHtml(title).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
function parseDate(value) {
  if (!value) return null;
  const direct = new Date(decodeHtml(value));
  return Number.isNaN(direct.getTime()) ? null : direct;
}
function isRecent(date) { return !date || date.getTime() >= NOW.getTime() - HOURS_WINDOW * 3600 * 1000; }
async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'WizardGroupNewsBot/1.0 (+GitHub Actions)', 'Accept': 'application/rss+xml, application/xml, text/html;q=0.9, */*;q=0.8' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally { clearTimeout(timer); }
}

function tag(block, name) {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return match ? decodeHtml(match[1]) : '';
}
function attr(block, tagName, attrName) {
  const match = block.match(new RegExp(`<${tagName}[^>]*\\s${attrName}=["']([^"']+)["'][^>]*>`, 'i'));
  return match ? decodeHtml(match[1]) : '';
}
function parseRss(xml, source) {
  const blocks = xml.match(/<(?:item|entry)(?:\s[^>]*)?>[\s\S]*?<\/(?:item|entry)>/gi) || [];
  return blocks.map(block => {
    const link = attr(block, 'link', 'href') || tag(block, 'link') || tag(block, 'guid');
    return {
      source: source.id, sourceName: source.name, sourceUrl: source.url,
      articleUrl: normalizeUrl(link), title: tag(block, 'title'),
      summary: tag(block, 'description') || tag(block, 'content:encoded') || tag(block, 'summary'),
      publishedAt: parseDate(tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated')),
      imageUrl: normalizeUrl(attr(block, 'media:content', 'url') || attr(block, 'enclosure', 'url')),
      sourceCategory: tag(block, 'category')
    };
  }).filter(item => item.articleUrl && item.title);
}
function extractJsonLd(html, source) {
  const scripts = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
  const articles = [];
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    const type = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
    if (type.some(t => /Article|NewsArticle|BlogPosting/i.test(String(t))) && (node.headline || node.name) && (node.url || node.mainEntityOfPage)) {
      const image = Array.isArray(node.image) ? node.image[0] : (node.image && node.image.url) || node.image;
      articles.push({
        source: source.id, sourceName: source.name, sourceUrl: source.url,
        articleUrl: normalizeUrl(typeof node.mainEntityOfPage === 'object' ? node.mainEntityOfPage['@id'] : node.url || node.mainEntityOfPage),
        title: decodeHtml(node.headline || node.name), summary: decodeHtml(node.description || ''),
        publishedAt: parseDate(node.datePublished || node.dateModified), imageUrl: normalizeUrl(image || '')
      });
    }
    Object.values(node).forEach(visit);
  };
  scripts.forEach(script => {
    const raw = script.replace(/^<script[^>]*>|<\/script>$/gi, '').trim();
    try { visit(JSON.parse(raw)); } catch { /* JSON-LD incompleto: se intenta el siguiente respaldo */ }
  });
  return articles.filter(item => item.articleUrl && item.title);
}
function extractHomepageLinks(html, source) {
  const results = [];
  const pattern = /<(?:h2|h3|h4)[^>]*>[\s\S]{0,400}?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]{0,1200}?<\/(?:h2|h3|h4)>/gi;
  for (const match of html.matchAll(pattern)) {
    const url = normalizeUrl(new URL(decodeHtml(match[1]), source.url).toString());
    const title = decodeHtml(match[2]);
    if (url && title && url.startsWith(new URL(source.url).origin)) results.push({ source:source.id, sourceName:source.name, sourceUrl:source.url, articleUrl:url, title, summary:'', publishedAt:null, imageUrl:'' });
  }
  return results;
}
async function extractWithPriority(source) {
  for (const feedUrl of source.feeds) {
    try {
      const xml = await fetchText(feedUrl);
      const items = parseRss(xml, source);
      if (items.length) { log(`${source.name}: RSS disponible (${items.length})`); return items; }
    } catch (error) { log(`${source.name}: feed no disponible ${feedUrl} (${error.message})`); }
  }
  const html = await fetchText(source.url);
  const structured = extractJsonLd(html, source);
  if (structured.length) { log(`${source.name}: usando JSON-LD (${structured.length})`); return structured; }
  const links = extractHomepageLinks(html, source);
  log(`${source.name}: usando extractor HTML específico (${links.length})`);
  return links;
}
async function extract100Seguro(source) { return extractWithPriority(source); }
async function extractTiempoDeSeguros(source) { return extractWithPriority(source); }
async function extractRevistaAAPAS(source) { return extractWithPriority(source); }

function classify(article) {
  const text = `${article.title} ${article.summary}`.toLowerCase();
  const matches = (words, category) => words.some(word => text.includes(word)) ? category : null;
  const categories = [
    matches(['ssn','superintendencia','resoluci','normativa','regulaci','boletín oficial'], 'SSN / Regulación'),
    matches(['productor','pas ','p.a.s','broker'], 'PAS / Productores'),
    matches(['automotor','auto ','vehículo','moto','telemática'], 'Automotor'),
    matches(['riesgo del trabajo','art ','srt '], 'Riesgos del Trabajo'),
    matches(['vida','salud'], 'Vida'), matches(['retiro','jubil'], 'Retiro'),
    matches(['caución','caucion'], 'Caución'), matches(['reaseguro'], 'Reaseguros'),
    matches(['insurtech','tecnolog','digital','ia ','inteligencia artificial','agentes de ia'], 'Tecnología / Insurtech'),
    matches(['prevenci','seguridad vial','fraude'], 'Prevención'),
    matches(['aseguradora','compañía','compania','mapfre','san cristóbal','la segunda'], 'Compañías'),
    matches(['mercado','economía','economia','inflación','inflacion'], 'Mercado')
  ].filter(Boolean);
  return { category: categories[0] || 'Otros', secondaryCategories: categories.slice(1) };
}
function fallbackAnalysis(article) {
  return {
    aiSummary: article.summary ? article.summary.slice(0, 500) : 'No surge un extracto del artículo consultado.',
    aiAnalysis: 'No surge del artículo consultado.', aiImpact: 'No surge del artículo consultado.',
    aiAction: 'No requiere acción inmediata.', importance: 'BAJA'
  };
}
function compactText(value, max = 6000) { return decodeHtml(value || '').slice(0, max); }
async function articleContext(article) {
  try {
    const html = await fetchText(article.articleUrl);
    const jsonLd = extractJsonLd(html, { ...article, id:article.source, name:article.sourceName, url:article.sourceUrl });
    const match = jsonLd.find(item => item.articleUrl === article.articleUrl) || jsonLd[0];
    const text = compactText((match && match.summary) || article.summary);
    return text || compactText(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' '));
  } catch (error) { log(`No se pudo ampliar artículo ${article.articleUrl}: ${error.message}`); return compactText(article.summary); }
}
async function analyzeWithGemini(article) {
  if (!process.env.GEMINI_API_KEY) return fallbackAnalysis(article);
  const context = await articleContext(article);
  const prompt = `Analizá esta noticia para productores asesores de seguros de Argentina. Usá exclusivamente el título y extracto provistos. No inventes datos, fechas, alcances ni predicciones. Cuando no sea claro, escribí exactamente “No surge del artículo consultado.”. Diferenciá hecho, interpretación y recomendación con un tono profesional y prudente. Respondé solo JSON válido con: aiSummary (máximo 500 caracteres), aiAnalysis (por qué importa, máximo 420 caracteres), aiImpact (impacto para un PAS, máximo 420 caracteres), aiAction (acción concreta o “No requiere acción inmediata.”, máximo 220 caracteres), importance (ALTA, MEDIA o BAJA).\n\nTÍTULO: ${article.title}\n\nEXTRACTO: ${context}`;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
  try {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 25000);
    const response = await fetch(endpoint, { method:'POST', signal:controller.signal, headers:{'Content-Type':'application/json'}, body:JSON.stringify({ contents:[{parts:[{text:prompt}]}], generationConfig:{ responseMimeType:'application/json', temperature:0.1, maxOutputTokens:700 } }) });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`Gemini HTTP ${response.status}: ${(await response.text()).slice(0,300)}`);
    const payload = await response.json();
    const raw = payload.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '';
    const result = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, ''));
    return {
      aiSummary: compactText(result.aiSummary, 500) || fallbackAnalysis(article).aiSummary,
      aiAnalysis: compactText(result.aiAnalysis, 420) || 'No surge del artículo consultado.',
      aiImpact: compactText(result.aiImpact, 420) || 'No surge del artículo consultado.',
      aiAction: compactText(result.aiAction, 220) || 'No requiere acción inmediata.',
      importance: ['ALTA','MEDIA','BAJA'].includes(String(result.importance).toUpperCase()) ? String(result.importance).toUpperCase() : 'BAJA'
    };
  } catch (error) { log(`Gemini falló para “${article.title}”: ${error.message}`); return fallbackAnalysis(article); }
}
function deduplicate(items) {
  const urls = new Set(), titles = new Set();
  return items.filter(item => {
    const title = normalizedTitle(item.title);
    if (!item.articleUrl || !title || urls.has(item.articleUrl) || titles.has(title)) return false;
    urls.add(item.articleUrl); titles.add(title); return true;
  });
}
async function removeExpired() {
  const cutoff = Timestamp.fromDate(new Date(NOW.getTime() - RETENTION_DAYS * 86400 * 1000));
  const snap = await db.collection('noticias').where('publishedAt', '<', cutoff).get();
  if (snap.empty) return;
  const batch = db.batch(); snap.docs.forEach(doc => batch.delete(doc.ref)); await batch.commit();
  log(`Retención: ${snap.size} noticia(s) anterior(es) a ${RETENTION_DAYS} días eliminada(s).`);
}
async function main() {
  log(`Inicio ${NOW.toISOString()}; ventana de ${HOURS_WINDOW} horas.`);
  const settled = await Promise.allSettled(SOURCES.map(async source => source.extract(source)));
  const candidates = settled.flatMap((result, index) => {
    if (result.status === 'rejected') { console.error(`[news] Fuente ${SOURCES[index].name} falló:`, result.reason); return []; }
    return result.value;
  }).map(item => ({ ...item, fetchedAt:NOW, publishedAt:item.publishedAt || NOW, publishedAtEstimated:!item.publishedAt }))
    .filter(item => isRecent(item.publishedAt));
  const unique = deduplicate(candidates);
  log(`Candidatas recientes: ${candidates.length}; únicas: ${unique.length}.`);
  const existing = await Promise.all(unique.map(item => db.collection('noticias').doc(articleId(item.articleUrl)).get()));
  const newItems = unique.filter((_, index) => !existing[index].exists).slice(0, MAX_NEW_PER_RUN);
  log(`Nuevas a procesar: ${newItems.length}.`);
  for (const article of newItems) {
    const analysis = await analyzeWithGemini(article);
    const categories = classify(article);
    const id = articleId(article.articleUrl);
    await db.collection('noticias').doc(id).set({
      id, source:article.source, sourceName:article.sourceName, sourceUrl:article.sourceUrl,
      articleUrl:article.articleUrl, title:compactText(article.title, 500), summary:compactText(article.summary, 900),
      publishedAt:Timestamp.fromDate(article.publishedAt), fetchedAt:Timestamp.fromDate(NOW),
      category:categories.category, secondaryCategories:categories.secondaryCategories,
      imageUrl:article.imageUrl || '', status:'published', createdAt:Timestamp.fromDate(NOW), updatedAt:Timestamp.fromDate(NOW),
      ...analysis
    });
    log(`Guardada: ${article.sourceName} — ${article.title}`);
  }
  await removeExpired();
  log('Finalizado correctamente.');
}

main().catch(error => { console.error('[news] Error fatal:', error); process.exit(1); });
