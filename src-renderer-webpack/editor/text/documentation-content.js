'use strict';

const normalizeSearch = value => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

const slugify = value => normalizeSearch(value)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'topico';

const markdownToText = markdown => String(markdown || '')
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/[*_|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const firstSummary = markdown => {
    const paragraphs = String(markdown || '').split(/\n\s*\n/).map(markdownToText).filter(Boolean);
    const paragraph = paragraphs.find(value => !/^arquivo gerado/i.test(value)) || paragraphs[0] || '';
    return paragraph.length > 150 ? `${paragraph.slice(0, 147).trim()}…` : paragraph;
};

const splitMarkdownDocument = ({id, group, markdown, overviewTitle}) => {
    const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
    const sections = [];
    let documentTitle = '';
    let current = {title: overviewTitle, lines: []};

    const finish = () => {
        const body = current.lines.join('\n').trim();
        if (!body) return;
        sections.push({
            id: `${id}-${slugify(current.title)}`,
            documentId: id,
            group,
            title: current.title,
            summary: firstSummary(body),
            markdown: body,
            searchText: normalizeSearch(`${group} ${current.title} ${markdownToText(body)}`),
            type: 'markdown'
        });
    };

    lines.forEach(line => {
        const firstHeading = line.match(/^#\s+(.+)$/);
        if (firstHeading && !documentTitle) {
            documentTitle = firstHeading[1].trim();
            return;
        }
        const sectionHeading = line.match(/^#{2,3}\s+(.+)$/);
        if (sectionHeading) {
            finish();
            current = {title: sectionHeading[1].trim(), lines: []};
            return;
        }
        current.lines.push(line);
    });
    finish();
    return sections;
};

const argumentList = metadata => (metadata.arguments || []).map(argument => argument.name).join(', ');

const extensionSyntax = metadata => {
    const call = `${metadata.canonicalName}(${argumentList(metadata)})`;
    if (metadata.kind === 'hat' || metadata.kind === 'event') return `on ${call}:`;
    if (metadata.kind === 'conditional' || metadata.kind === 'loop') return `${call}:`;
    return call;
};

const extensionScope = metadata => {
    if (metadata.allowStage === false) return 'Somente atores';
    if (metadata.allowSprite === false) return 'Somente palco';
    return 'Palco e atores';
};

const buildExtensionSection = (extensionCatalog, extensionPalette) => {
    const entries = Object.values(extensionCatalog || {}).sort((left, right) =>
        left.canonicalName.localeCompare(right.canonicalName)
    ).map(metadata => ({
        name: metadata.canonicalName,
        syntax: extensionSyntax(metadata),
        opcode: metadata.opcode,
        kind: metadata.kind,
        scope: extensionScope(metadata),
        description: metadata.documentation || `${metadata.canonicalName} — bloco da extensão ${metadata.extensionId}`,
        extensionName: metadata.extensionName || metadata.extensionId
    }));
    const palette = (extensionPalette || []).filter(item =>
        ['button', 'label', 'xml', 'separator'].includes(item.kind)
    ).map(item => ({
        name: item.canonicalName,
        kind: item.kind,
        description: item.text || item.xml || 'Separador visual da paleta.',
        extensionName: item.extensionName || item.extensionId
    }));
    const searchText = normalizeSearch([
        'Projeto atual Extensões carregadas',
        ...entries.flatMap(entry => Object.values(entry)),
        ...palette.flatMap(entry => Object.values(entry))
    ].join(' '));
    return {
        id: 'runtime-extensoes-carregadas',
        documentId: 'runtime',
        group: 'Projeto atual',
        title: 'Extensões carregadas',
        summary: entries.length ?
            `${entries.length} bloco(s) executável(is) possuem sintaxe TextWarp neste projeto.` :
            'Carregue uma extensão para ver aqui suas chamadas TextWarp geradas pelo getInfo().',
        entries,
        palette,
        searchText,
        type: 'extensions'
    };
};

const buildDocumentationSections = options => [
    ...splitMarkdownDocument({
        id: 'manual',
        group: 'Manual TextWarp',
        markdown: options.guideMarkdown,
        overviewTitle: 'Visão geral'
    }),
    ...splitMarkdownDocument({
        id: 'ide',
        group: 'IDE TextWarp',
        markdown: options.ideMarkdown,
        overviewTitle: 'Visão geral da IDE'
    }),
    ...splitMarkdownDocument({
        id: 'reference',
        group: 'Referência completa',
        markdown: options.referenceMarkdown,
        overviewTitle: 'Sobre a referência'
    }),
    ...splitMarkdownDocument({
        id: 'status',
        group: 'Estado do projeto',
        markdown: options.prioritiesMarkdown,
        overviewTitle: 'Visão geral do status'
    }),
    buildExtensionSection(options.extensionCatalog, options.extensionPalette)
];

const filterDocumentationSections = (sections, query) => {
    const tokens = normalizeSearch(query).split(/\s+/).filter(Boolean);
    if (!tokens.length) return sections;
    return sections.reduce((result, section) => {
        const sectionHeader = normalizeSearch(`${section.group} ${section.title} ${section.summary}`);
        const headerMatches = tokens.every(token => sectionHeader.includes(token));
        if (section.type !== 'extensions') {
            if (tokens.every(token => section.searchText.includes(token))) result.push(section);
            return result;
        }
        const matches = value => tokens.every(token => normalizeSearch(Object.values(value).join(' ')).includes(token));
        const entries = headerMatches ? section.entries : section.entries.filter(matches);
        const palette = headerMatches ? section.palette : section.palette.filter(matches);
        if (headerMatches || entries.length || palette.length) result.push(Object.assign({}, section, {entries, palette}));
        return result;
    }, []);
};

module.exports = {
    buildDocumentationSections,
    filterDocumentationSections,
    markdownToText,
    normalizeSearch,
    slugify,
    splitMarkdownDocument
};
