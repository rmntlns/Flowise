import fs from 'fs'
import path from 'path'
import ts from 'typescript'
import { cloneDeep, get } from 'lodash'

// Execute the real pure resolver functions without booting the database or loading
// every provider exported by flowise-components. No resolver implementation is mocked.
function declarations(file: string, names: string[]): string {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2021, true)
    const selected = source.statements.filter((statement) => {
        if (ts.isFunctionDeclaration(statement)) return !!statement.name && names.includes(statement.name.text)
        if (!ts.isVariableStatement(statement)) return false
        return statement.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && names.includes(d.name.text))
    })
    if (selected.length !== names.length) throw new Error(`Missing test declarations in ${file}`)
    return selected.map((statement) => statement.getText(source)).join('\n')
}

const componentFunctions = declarations(path.join(__dirname, '../../../components/src/utils.ts'), [
    'jsonEscapeCharacters',
    'handleEscapesJSONParse',
    'iterateEscapesJSONParse',
    'handleEscapeCharacters',
    'convertChatHistoryToText'
])
const resolverFunctions = declarations(path.join(__dirname, 'index.ts'), [
    'QUESTION_VAR_PREFIX',
    'FILE_ATTACHMENT_PREFIX',
    'CHAT_HISTORY_VAR_PREFIX',
    'getGlobalVariable',
    'getVariableValue',
    'resolveVariables',
    'replaceInputsWithConfig'
])
const compiled = ts.transpileModule(componentFunctions + '\n' + resolverFunctions, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
}).outputText
const resolver: Record<string, (...args: any[]) => any> = {}
new Function('exports', 'cloneDeep', 'get', 'process', compiled)(resolver, cloneDeep, get, process)

const fields = ['firstname', 'lastname', 'lifecyclestage', 'packageid', 'softwareVersion', 'recentInteractions']
const enabled = fields.map((name) => ({ name, enabled: true }))
const defaults = () => fields.map((name) => ({ name, type: 'static', value: `default-${name}` }))
const customer = {
    firstname: 'Test',
    lastname: 'Customer',
    lifecyclestage: 'customer',
    packageid: 'Vip3D Yearly',
    softwareVersion: '2026.1.0',
    recentInteractions: 'Asked about a survey.\nRequested follow-up.'
}
const prompt = fields.map((name) => `${name}={{$vars.${name}}}`).join('\n')
const node = (systemMessage: string | string[] = prompt) => ({
    id: 'toolAgent_0',
    label: 'Tool Agent',
    inputs: { systemMessage },
    inputParams: [{ name: 'systemMessage', acceptVariable: true }]
})

async function resolve(
    vars?: Record<string, unknown>,
    options: {
        permissions?: { name: string; enabled: boolean }[]
        apiEnabled?: boolean
        variables?: ReturnType<typeof defaults>
        systemMessage?: string | string[]
    } = {}
) {
    let data = node(options.systemMessage)
    const permissions = options.permissions ?? enabled
    if (vars && options.apiEnabled !== false) {
        data = resolver.replaceInputsWithConfig(data, { vars: cloneDeep(vars) }, {}, permissions)
    }
    return resolver.resolveVariables(
        data,
        [],
        'Question unchanged',
        [],
        { sessionId: 'isolated-session' },
        '',
        options.variables ?? defaults(),
        permissions
    )
}

describe('request variable propagation into prompt resolution', () => {
    it('resolves all six permitted customer fields in the actual prompt', async () => {
        const result = await resolve(customer)
        expect(result.inputs.systemMessage).toBe(fields.map((name) => `${name}=${customer[name as keyof typeof customer]}`).join('\n'))
    })

    it('keeps defaults when the request omits vars', async () => {
        const result = await resolve()
        expect(result.inputs.systemMessage).toBe(fields.map((name) => `${name}=default-${name}`).join('\n'))
    })

    it('keeps defaults when API overrides are disabled', async () => {
        const result = await resolve(customer, { apiEnabled: false })
        expect(result.inputs.systemMessage).toContain('firstname=default-firstname')
        expect(result.inputs.systemMessage).not.toContain('Vip3D Yearly')
    })

    it('does not apply disabled or unlisted variables', async () => {
        const result = await resolve(customer, {
            permissions: [
                { name: 'firstname', enabled: true },
                { name: 'packageid', enabled: false }
            ]
        })
        expect(result.inputs.systemMessage).toContain('firstname=Test')
        expect(result.inputs.systemMessage).toContain('packageid=default-packageid')
        expect(result.inputs.systemMessage).toContain('lastname=default-lastname')
    })

    it('preserves an explicitly empty field instead of substituting a default', async () => {
        const result = await resolve({ firstname: '' }, { systemMessage: 'Name=[{{$vars.firstname}}]' })
        expect(result.inputs.systemMessage).toBe('Name=[]')
    })

    it('handles variables in array-valued prompts', async () => {
        const result = await resolve(customer, { systemMessage: ['{{$vars.firstname}}', '{{$vars.packageid}}'] })
        expect(result.inputs.systemMessage).toEqual(['Test', 'Vip3D Yearly'])
    })

    it('preserves flow metadata and the original question', async () => {
        const result = await resolve(customer, { systemMessage: '{{$flow.sessionId}} / {{question}} / {{$vars.firstname}}' })
        expect(result.inputs.systemMessage).toBe('isolated-session / Question unchanged / Test')
    })

    it('does not mutate stored defaults, including runtime variable types', async () => {
        const variables = defaults()
        variables[0].type = 'runtime'
        const before = cloneDeep(variables)
        const result = await resolver.getGlobalVariable({ vars: customer }, variables, enabled)
        expect(result.firstname).toBe('Test')
        expect(variables).toEqual(before)
    })

    it('isolates two concurrent profiles and a subsequent request without overrides', async () => {
        const variables = defaults()
        const before = cloneDeep(variables)
        const [a, b] = await Promise.all([
            resolve({ firstname: 'Customer A' }, { variables }),
            resolve({ firstname: 'Customer B' }, { variables })
        ])
        expect(a.inputs.systemMessage).toContain('firstname=Customer A')
        expect(b.inputs.systemMessage).toContain('firstname=Customer B')
        const next = await resolve(undefined, { variables })
        expect(next.inputs.systemMessage).toContain('firstname=default-firstname')
        expect(variables).toEqual(before)
    })

    it('retains legacy flow-config variables when there are no node overrides', async () => {
        const result = await resolver.resolveVariables(
            node('{{$vars.firstname}}'),
            [],
            '',
            [],
            { vars: { firstname: 'Existing caller' } },
            '',
            defaults(),
            enabled
        )
        expect(result.inputs.systemMessage).toBe('Existing caller')
    })
})
