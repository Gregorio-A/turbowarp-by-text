import PropTypes from 'prop-types';
import React from 'react';
import {marked} from 'marked';

import guideMarkdown from '../../../TEXTWARP.md';
import prioritiesMarkdown from '../../../TEXTWARP_PRIORIDADES.md';
import referenceMarkdown from '../../../TEXTWARP_BLOCOS.md';
import {buildDocumentationSections, filterDocumentationSections} from './documentation-content';
import styles from './documentation-pane.css';

const GROUP_ORDER = ['Manual TextWarp', 'Referência completa', 'Estado do projeto', 'Projeto atual'];
const DOCUMENT_LINKS = Object.freeze({
    'TEXTWARP.md': 'manual-visao-geral',
    'TEXTWARP_BLOCOS.md': 'reference-sobre-a-referencia',
    'TEXTWARP_PRIORIDADES.md': 'status-visao-geral-do-status'
});

const groupSections = sections => GROUP_ORDER.map(group => ({
    group,
    sections: sections.filter(section => section.group === group)
})).filter(item => item.sections.length);

class DocumentationPane extends React.PureComponent {
    constructor (props) {
        super(props);
        this.state = {activeId: 'manual-visao-geral', query: ''};
        this.article = null;
        this.markdownBody = null;
        this.copyTimer = null;
        this.handleMarkdownClick = this.handleMarkdownClick.bind(this);
    }

    componentDidMount () {
        this.addCopyButtons();
    }

    componentDidUpdate () {
        this.addCopyButtons();
    }

    componentWillUnmount () {
        clearTimeout(this.copyTimer);
    }

    getSections () {
        return buildDocumentationSections({
            extensionCatalog: this.props.extensionCatalog,
            extensionPalette: this.props.extensionPalette,
            guideMarkdown,
            prioritiesMarkdown,
            referenceMarkdown
        });
    }

    selectSection (activeId) {
        this.setState({activeId}, () => {
            if (this.article) this.article.scrollTop = 0;
        });
    }

    async copyCode (button, code) {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(code);
            } else {
                const input = document.createElement('textarea');
                input.value = code;
                input.style.position = 'fixed';
                input.style.opacity = '0';
                document.body.appendChild(input);
                input.select();
                document.execCommand('copy');
                input.remove();
            }
            button.textContent = 'Copiado';
            clearTimeout(this.copyTimer);
            this.copyTimer = setTimeout(() => {
                if (button.isConnected) button.textContent = 'Copiar';
            }, 1500);
        } catch (error) {
            button.textContent = 'Não foi possível copiar';
        }
    }

    addCopyButtons () {
        if (!this.markdownBody) return;
        Array.from(this.markdownBody.querySelectorAll('pre')).forEach(block => {
            if (block.querySelector(`.${styles.copyButton}`)) return;
            const button = document.createElement('button');
            button.className = styles.copyButton;
            button.textContent = 'Copiar';
            button.type = 'button';
            button.setAttribute('aria-label', 'Copiar exemplo de código');
            button.addEventListener('click', () => {
                const code = block.querySelector('code');
                this.copyCode(button, code ? code.textContent : block.textContent);
            });
            block.appendChild(button);
        });
    }

    handleMarkdownClick (event) {
        const link = event.target.closest && event.target.closest('a');
        if (!link) return;
        const href = link.getAttribute('href');
        if (!DOCUMENT_LINKS[href]) return;
        event.preventDefault();
        this.selectSection(DOCUMENT_LINKS[href]);
    }

    renderExtensionReference (section) {
        return (
            <div className={styles.runtimeReference}>
                <p className={styles.lead}>{section.summary}</p>
                {section.entries.length ? (
                    <div className={styles.referenceList}>
                        {section.entries.map(entry => (
                            <article className={styles.referenceEntry} key={entry.name}>
                                <div className={styles.referenceTitle}>
                                    <code>{entry.syntax}</code>
                                    <span>{entry.kind}</span>
                                </div>
                                <p>{entry.description}</p>
                                <div className={styles.referenceMeta}>
                                    <span>{entry.extensionName}</span>
                                    <code>{entry.opcode}</code>
                                    <span>{entry.scope}</span>
                                </div>
                            </article>
                        ))}
                    </div>
                ) : <div className={styles.emptyState}>Nenhum bloco de extensão corresponde à busca atual.</div>}
                {section.palette.length > 0 && (
                    <React.Fragment>
                        <h2>Itens não executáveis da paleta</h2>
                        <p>Rótulos, botões, separadores e XML aparecem na paleta, mas não são comandos da linguagem.</p>
                        <div className={styles.paletteList}>
                            {section.palette.map((entry, index) => (
                                <div key={`${entry.name}:${index}`}>
                                    <span>{entry.kind}</span>
                                    <code>{entry.name}</code>
                                    <p>{entry.description}</p>
                                </div>
                            ))}
                        </div>
                    </React.Fragment>
                )}
            </div>
        );
    }

    render () {
        const sections = this.getSections();
        const filtered = filterDocumentationSections(sections, this.state.query);
        const active = filtered.find(section => section.id === this.state.activeId) || filtered[0] || null;
        const executableCount = Object.keys(this.props.extensionCatalog || {}).length;
        return (
            <div className={styles.root}>
                <aside className={styles.sidebar} aria-label="Índice da documentação TextWarp">
                    <div className={styles.sidebarHeader}>
                        <span className={styles.eyebrow}>TextWarp 0.3</span>
                        <strong>Documentação</strong>
                        <p>Manual, referência completa e estado atual no mesmo lugar.</p>
                    </div>
                    <label className={styles.search}>
                        <span>Buscar na documentação</span>
                        <input
                            placeholder="Ex.: movimento, procedure, extensão…"
                            type="search"
                            value={this.state.query}
                            onChange={event => this.setState({query: event.target.value})}
                        />
                    </label>
                    <nav className={styles.navigation}>
                        {groupSections(filtered).map(item => (
                            <section key={item.group}>
                                <h2>{item.group}</h2>
                                {item.sections.map(section => (
                                    <button
                                        aria-current={active && active.id === section.id ? 'page' : undefined}
                                        className={active && active.id === section.id ? styles.activeItem : ''}
                                        key={section.id}
                                        type="button"
                                        onClick={() => this.selectSection(section.id)}
                                    >
                                        <span>{section.title}</span>
                                        {section.type === 'extensions' && <small>{section.entries.length}</small>}
                                    </button>
                                ))}
                            </section>
                        ))}
                        {!filtered.length && (
                            <div className={styles.noResults}>
                                <strong>Nenhum tópico encontrado.</strong>
                                <button type="button" onClick={() => this.setState({query: ''})}>Limpar busca</button>
                            </div>
                        )}
                    </nav>
                    <div className={styles.sidebarFooter}>
                        <span>{sections.length} tópicos</span>
                        <span>{executableCount} bloco(s) de extensão</span>
                    </div>
                </aside>
                <main className={styles.article} ref={element => { this.article = element; }}>
                    {active && (
                        <div className={styles.articleInner}>
                            <div className={styles.breadcrumb}>{active.group}</div>
                            <h1>{active.title}</h1>
                            {active.type === 'markdown' ? (
                                <div
                                    className={styles.markdown}
                                    dangerouslySetInnerHTML={{__html: marked.parse(active.markdown)}}
                                    ref={element => { this.markdownBody = element; }}
                                    onClick={this.handleMarkdownClick}
                                />
                            ) : this.renderExtensionReference(active)}
                        </div>
                    )}
                </main>
            </div>
        );
    }
}

DocumentationPane.propTypes = {
    extensionCatalog: PropTypes.objectOf(PropTypes.shape({})),
    extensionPalette: PropTypes.arrayOf(PropTypes.shape({}))
};

DocumentationPane.defaultProps = {
    extensionCatalog: {},
    extensionPalette: []
};

export default DocumentationPane;
