import PropTypes from 'prop-types';
import React from 'react';

import {loadMonaco} from './monaco-loader';

class MonacoEditor extends React.Component {
    constructor (props) {
        super(props);
        this.state = {loadError: null};
        this.container = null;
        this.editor = null;
        this.monaco = null;
        this.models = new Map();
        this.changeSubscription = null;
        this.mouseSubscription = null;
        this.decorationIds = [];
        this.ignoreChanges = false;
        this.setContainer = element => {
            this.container = element;
        };
    }
    componentDidMount () {
        loadMonaco().then(monaco => {
            if (!this.container) return;
            this.monaco = monaco;
            this.container.textContent = '';
            const model = this.getModel(this.props.modelKey, this.props.value);
            this.editor = monaco.editor.create(this.container, {
                model,
                theme: this.props.dark ? 'vs-dark' : 'vs',
                automaticLayout: true,
                fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
                fontSize: 15,
                lineHeight: 23,
                minimap: {enabled: true},
                glyphMargin: true,
                padding: {top: 14, bottom: 14},
                renderWhitespace: 'selection',
                scrollBeyondLastLine: false,
                smoothScrolling: true,
                tabSize: 4,
                insertSpaces: true,
                wordWrap: 'on',
                ariaLabel: 'Editor de código TextWarp'
            });
            this.changeSubscription = this.editor.onDidChangeModelContent(() => {
                if (!this.ignoreChanges) this.props.onChange(this.editor.getValue());
            });
            this.mouseSubscription = this.editor.onMouseDown(event => {
                const gutter = event.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
                    event.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS;
                if (gutter && event.target.position && this.props.onToggleBreakpoint) {
                    this.props.onToggleBreakpoint(event.target.position.lineNumber);
                }
            });
            this.updateMarkers();
            this.updateDecorations();
        }).catch(error => {
            console.error(error);
            this.setState({loadError: error.message});
        });
    }
    componentDidUpdate (previousProps) {
        if (!this.editor || !this.monaco) return;
        if (previousProps.modelKey !== this.props.modelKey) {
            this.editor.setModel(this.getModel(this.props.modelKey, this.props.value));
        } else if (previousProps.value !== this.props.value && this.editor.getValue() !== this.props.value) {
            this.ignoreChanges = true;
            this.editor.setValue(this.props.value);
            this.ignoreChanges = false;
        }
        if (previousProps.dark !== this.props.dark) {
            this.monaco.editor.setTheme(this.props.dark ? 'vs-dark' : 'vs');
        }
        if (previousProps.diagnostics !== this.props.diagnostics || previousProps.modelKey !== this.props.modelKey) {
            this.updateMarkers();
        }
        if (
            previousProps.activeLines !== this.props.activeLines ||
            previousProps.breakpoints !== this.props.breakpoints ||
            previousProps.modelKey !== this.props.modelKey
        ) this.updateDecorations();
        if (this.props.visible && !previousProps.visible) this.editor.layout();
    }
    componentWillUnmount () {
        if (this.changeSubscription) this.changeSubscription.dispose();
        if (this.mouseSubscription) this.mouseSubscription.dispose();
        if (this.editor) this.editor.dispose();
        this.models.forEach(model => model.dispose());
        this.models.clear();
    }
    getModel (key, value) {
        if (this.models.has(key)) {
            const existing = this.models.get(key);
            if (existing.getValue() !== value) existing.setValue(value);
            return existing;
        }
        const safeKey = encodeURIComponent(key || 'target');
        const uri = this.monaco.Uri.parse(`inmemory://textwarp/${safeKey}.tw`);
        const model = this.monaco.editor.createModel(value, 'textwarp', uri);
        this.models.set(key, model);
        return model;
    }
    updateMarkers () {
        if (!this.editor || !this.monaco) return;
        const model = this.editor.getModel();
        const markers = this.props.diagnostics.map(item => ({
            severity: item.severity === 'warning' ?
                this.monaco.MarkerSeverity.Warning :
                this.monaco.MarkerSeverity.Error,
            message: item.message,
            startLineNumber: item.line,
            startColumn: item.column,
            endLineNumber: item.endLine,
            endColumn: item.endColumn,
            code: item.code
        }));
        this.monaco.editor.setModelMarkers(model, 'textwarp', markers);
    }
    updateDecorations () {
        if (!this.editor || !this.monaco) return;
        const decorations = [];
        this.props.breakpoints.forEach(line => decorations.push({
            range: new this.monaco.Range(line, 1, line, 1),
            options: {
                glyphMarginClassName: 'textwarp-breakpoint-glyph',
                glyphMarginHoverMessage: {value: `Breakpoint na linha ${line}`}
            }
        }));
        this.props.activeLines.forEach(line => decorations.push({
            range: new this.monaco.Range(line, 1, line, 1),
            options: {
                isWholeLine: true,
                className: 'textwarp-active-line',
                glyphMarginClassName: 'textwarp-active-glyph'
            }
        }));
        this.decorationIds = this.editor.deltaDecorations(this.decorationIds, decorations);
    }
    render () {
        if (this.state.loadError) {
            return (
                <div style={{height: '100%', display: 'flex', flexDirection: 'column'}}>
                    <div style={{padding: '0.5rem', color: '#c33'}}>
                        Monaco indisponível; usando editor básico. {this.state.loadError}
                    </div>
                    <textarea
                        aria-label="Editor de código TextWarp"
                        spellCheck={false}
                        style={{flex: 1, resize: 'none', fontFamily: 'monospace', fontSize: 15, padding: 14}}
                        value={this.props.value}
                        onChange={event => this.props.onChange(event.target.value)}
                    />
                </div>
            );
        }
        return (
            <div
                ref={this.setContainer}
                style={{width: '100%', height: '100%'}}
            >
                Carregando editor…
            </div>
        );
    }
}

MonacoEditor.propTypes = {
    activeLines: PropTypes.arrayOf(PropTypes.number),
    breakpoints: PropTypes.arrayOf(PropTypes.number),
    dark: PropTypes.bool,
    diagnostics: PropTypes.arrayOf(PropTypes.shape({
        message: PropTypes.string.isRequired,
        line: PropTypes.number.isRequired,
        column: PropTypes.number.isRequired,
        endLine: PropTypes.number.isRequired,
        endColumn: PropTypes.number.isRequired,
        severity: PropTypes.string.isRequired
    })).isRequired,
    modelKey: PropTypes.string.isRequired,
    onChange: PropTypes.func.isRequired,
    onToggleBreakpoint: PropTypes.func,
    value: PropTypes.string.isRequired,
    visible: PropTypes.bool
};

MonacoEditor.defaultProps = {
    activeLines: [],
    breakpoints: []
};

export default MonacoEditor;
