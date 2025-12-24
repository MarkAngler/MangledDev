const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

// Safe JSON file read with error handling
function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    return null;
  }
}

// Extract YAML frontmatter from markdown content
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const yaml = {};
  match[1].split('\n').forEach(line => {
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      let value = line.slice(colonIndex + 1).trim();
      // Remove surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      yaml[key] = value;
    }
  });
  return yaml;
}

// Recursively find all .md files in a directory
function findMdFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findMdFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }
  } catch (err) {
    // Ignore permission errors
  }
  return results;
}

// Scan enabled plugins from settings.json and installed_plugins.json
function scanPlugins(settingsPath, installedPluginsPath) {
  const plugins = [];

  const settings = readJsonFile(settingsPath);
  const enabledPlugins = settings?.enabledPlugins || {};

  const installed = readJsonFile(installedPluginsPath);
  const installedData = installed?.plugins || {};

  for (const [pluginId, enabled] of Object.entries(enabledPlugins)) {
    if (!enabled) continue;

    const [name, marketplace] = pluginId.includes('@')
      ? pluginId.split('@')
      : [pluginId, 'local'];

    const installInfo = installedData[pluginId]?.[0];

    plugins.push({
      name,
      marketplace: marketplace || 'local',
      version: installInfo?.version || null,
      installPath: installInfo?.installPath || null
    });
  }

  return plugins;
}

// Scan skills from plugin cache or project directory
function scanSkills(baseDir, isPluginCache = false) {
  const skills = [];

  if (isPluginCache) {
    // Plugin cache structure: cache/{marketplace}/{plugin}/skills/*/SKILL.md
    const cacheDir = path.join(baseDir, 'plugins', 'cache');
    if (!fs.existsSync(cacheDir)) return skills;

    try {
      const marketplaces = fs.readdirSync(cacheDir, { withFileTypes: true })
        .filter(d => d.isDirectory());

      for (const marketplace of marketplaces) {
        const marketplacePath = path.join(cacheDir, marketplace.name);
        const pluginDirs = fs.readdirSync(marketplacePath, { withFileTypes: true })
          .filter(d => d.isDirectory());

        for (const plugin of pluginDirs) {
          const skillsDir = path.join(marketplacePath, plugin.name, 'skills');
          if (!fs.existsSync(skillsDir)) continue;

          const skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true })
            .filter(d => d.isDirectory());

          for (const skillDir of skillDirs) {
            const skillFile = path.join(skillsDir, skillDir.name, 'SKILL.md');
            if (!fs.existsSync(skillFile)) continue;

            try {
              const content = fs.readFileSync(skillFile, 'utf8');
              const frontmatter = parseFrontmatter(content);
              skills.push({
                name: frontmatter.name || skillDir.name,
                description: frontmatter.description || null,
                source: `${plugin.name}@${marketplace.name}`,
                path: skillFile
              });
            } catch (err) {
              // Skip unreadable files
            }
          }
        }
      }
    } catch (err) {
      // Ignore errors
    }
  } else {
    // Project structure: .claude/skills/*/SKILL.md
    const skillsDir = path.join(baseDir, 'skills');
    if (!fs.existsSync(skillsDir)) return skills;

    try {
      const skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter(d => d.isDirectory());

      for (const skillDir of skillDirs) {
        const skillFile = path.join(skillsDir, skillDir.name, 'SKILL.md');
        if (!fs.existsSync(skillFile)) continue;

        try {
          const content = fs.readFileSync(skillFile, 'utf8');
          const frontmatter = parseFrontmatter(content);
          skills.push({
            name: frontmatter.name || skillDir.name,
            description: frontmatter.description || null,
            source: 'project',
            path: skillFile
          });
        } catch (err) {
          // Skip unreadable files
        }
      }
    } catch (err) {
      // Ignore errors
    }
  }

  return skills;
}

// Scan agents from plugin cache or project directory
function scanAgents(baseDir, isPluginCache = false) {
  const agents = [];

  if (isPluginCache) {
    // Plugin cache structure: cache/{marketplace}/{plugin}/agents/*.md
    const cacheDir = path.join(baseDir, 'plugins', 'cache');
    if (!fs.existsSync(cacheDir)) return agents;

    try {
      const marketplaces = fs.readdirSync(cacheDir, { withFileTypes: true })
        .filter(d => d.isDirectory());

      for (const marketplace of marketplaces) {
        const marketplacePath = path.join(cacheDir, marketplace.name);
        const pluginDirs = fs.readdirSync(marketplacePath, { withFileTypes: true })
          .filter(d => d.isDirectory());

        for (const plugin of pluginDirs) {
          const agentsDir = path.join(marketplacePath, plugin.name, 'agents');
          const agentFiles = findMdFiles(agentsDir);

          for (const file of agentFiles) {
            try {
              const content = fs.readFileSync(file, 'utf8');
              const frontmatter = parseFrontmatter(content);
              agents.push({
                name: frontmatter.name || path.basename(file, '.md'),
                description: frontmatter.description || null,
                model: frontmatter.model || null,
                source: `${plugin.name}@${marketplace.name}`,
                path: file
              });
            } catch (err) {
              // Skip unreadable files
            }
          }
        }
      }
    } catch (err) {
      // Ignore errors
    }
  } else {
    // Project structure: .claude/agents/*.md
    const agentsDir = path.join(baseDir, 'agents');
    const agentFiles = findMdFiles(agentsDir);

    for (const file of agentFiles) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        const frontmatter = parseFrontmatter(content);
        agents.push({
          name: frontmatter.name || path.basename(file, '.md'),
          description: frontmatter.description || null,
          model: frontmatter.model || null,
          source: 'project',
          path: file
        });
      } catch (err) {
        // Skip unreadable files
      }
    }
  }

  return agents;
}

// Scan commands from plugin cache or project directory
function scanCommands(baseDir, isPluginCache = false) {
  const commands = [];

  if (isPluginCache) {
    // Plugin cache structure: cache/{marketplace}/{plugin}/commands/**/*.md
    const cacheDir = path.join(baseDir, 'plugins', 'cache');
    if (!fs.existsSync(cacheDir)) return commands;

    try {
      const marketplaces = fs.readdirSync(cacheDir, { withFileTypes: true })
        .filter(d => d.isDirectory());

      for (const marketplace of marketplaces) {
        const marketplacePath = path.join(cacheDir, marketplace.name);
        const pluginDirs = fs.readdirSync(marketplacePath, { withFileTypes: true })
          .filter(d => d.isDirectory());

        for (const plugin of pluginDirs) {
          const commandsDir = path.join(marketplacePath, plugin.name, 'commands');
          const commandFiles = findMdFiles(commandsDir);

          for (const file of commandFiles) {
            try {
              const content = fs.readFileSync(file, 'utf8');
              const frontmatter = parseFrontmatter(content);
              commands.push({
                name: frontmatter.name || '/' + path.basename(file, '.md'),
                description: frontmatter.description || null,
                source: `${plugin.name}@${marketplace.name}`,
                path: file
              });
            } catch (err) {
              // Skip unreadable files
            }
          }
        }
      }
    } catch (err) {
      // Ignore errors
    }
  } else {
    // Project structure: .claude/commands/**/*.md
    const commandsDir = path.join(baseDir, 'commands');
    const commandFiles = findMdFiles(commandsDir);

    for (const file of commandFiles) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        const frontmatter = parseFrontmatter(content);
        commands.push({
          name: frontmatter.name || '/' + path.basename(file, '.md'),
          description: frontmatter.description || null,
          source: 'project',
          path: file
        });
      } catch (err) {
        // Skip unreadable files
      }
    }
  }

  return commands;
}

// Scan MCP servers from ~/.claude.json and .mcp.json
function scanMcpServers(claudeJsonPath, mcpJsonPath) {
  const servers = [];

  // Personal MCP from ~/.claude.json
  const claudeJson = readJsonFile(claudeJsonPath);
  if (claudeJson?.mcpServers) {
    for (const [name, config] of Object.entries(claudeJson.mcpServers)) {
      servers.push({
        name,
        type: config.type || (config.command ? 'stdio' : 'unknown'),
        url: config.url || null,
        command: config.command || null,
        scope: 'personal'
      });
    }
  }

  // Project MCP from .mcp.json
  const mcpJson = readJsonFile(mcpJsonPath);
  if (mcpJson?.mcpServers) {
    for (const [name, config] of Object.entries(mcpJson.mcpServers)) {
      servers.push({
        name,
        type: config.type || (config.command ? 'stdio' : 'unknown'),
        url: config.url || null,
        command: config.command || null,
        scope: 'project'
      });
    }
  }

  return servers;
}

// Scan hooks from settings.json
function scanHooks(settingsPath) {
  const settings = readJsonFile(settingsPath);
  const hooksConfig = settings?.hooks || {};
  const hooks = [];

  for (const [event, eventHooks] of Object.entries(hooksConfig)) {
    if (!Array.isArray(eventHooks)) continue;

    for (const hookDef of eventHooks) {
      hooks.push({
        event,
        matcher: hookDef.matcher || '*',
        type: hookDef.hooks?.[0]?.type || 'command',
        command: hookDef.hooks?.[0]?.command || null
      });
    }
  }

  return hooks;
}

// Main export: scan all extensions for personal and project scopes
function scanExtensions(projectCwd) {
  const personalSettingsPath = path.join(CLAUDE_DIR, 'settings.json');
  const personalInstalledPath = path.join(CLAUDE_DIR, 'plugins', 'installed_plugins.json');
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');

  const projectClaudeDir = path.join(projectCwd, '.claude');
  const projectSettingsPath = path.join(projectClaudeDir, 'settings.json');
  const projectMcpPath = path.join(projectCwd, '.mcp.json');

  // Scan personal (user-level) extensions
  const personal = {
    plugins: scanPlugins(personalSettingsPath, personalInstalledPath),
    skills: scanSkills(CLAUDE_DIR, true),
    agents: scanAgents(CLAUDE_DIR, true),
    commands: scanCommands(CLAUDE_DIR, true),
    mcpServers: scanMcpServers(claudeJsonPath, null).filter(s => s.scope === 'personal'),
    hooks: scanHooks(personalSettingsPath)
  };

  // Scan project-level extensions
  const project = {
    plugins: scanPlugins(projectSettingsPath, null),
    skills: scanSkills(projectClaudeDir, false),
    agents: scanAgents(projectClaudeDir, false),
    commands: scanCommands(projectClaudeDir, false),
    mcpServers: scanMcpServers(null, projectMcpPath).filter(s => s.scope === 'project'),
    hooks: scanHooks(projectSettingsPath)
  };

  return { personal, project };
}

module.exports = { scanExtensions };
