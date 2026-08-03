"""
Project Convention Learning System
Automatically captures and remembers project-specific patterns, commands, and environment details.
"""

import os
import json
import logging
import re
import platform
from typing import Dict, List, Optional, Any, Tuple
from pathlib import Path
from datetime import datetime
from .memory import MemoryManager


class ProjectConventionLearner:
    """Learns and remembers project-specific conventions automatically."""

    def __init__(self, memory_manager: MemoryManager, db_manager):
        self.memory_manager = memory_manager
        self.db = db_manager
        self.logger = logging.getLogger(__name__)

        self.convention_types = {
            'commands': 'Project-specific commands and scripts',
            'environment': 'Operating system and runtime environment details',
            'tools': 'Development tools and workflows used',
            'patterns': 'Code patterns and architectural decisions',
            'deployment': 'Build and deployment procedures',
            'dependencies': 'Package managers and dependency handling',
            'testing': 'Testing frameworks and procedures'
        }

        self.command_patterns = {
            'node_js': {
                'dev': ['npm run dev', 'npm start', 'yarn dev'],
                'build': ['npm run build', 'yarn build'],
                'test': ['npm test', 'yarn test'],
                'install': ['npm install', 'yarn install']
            },
            'python': {
                'run': ['python main.py', 'python app.py', 'uvicorn main:app'],
                'test': ['pytest', 'python -m pytest', 'python test.py'],
                'install': ['pip install -r requirements.txt', 'poetry install']
            },
            'rust': {
                'run': ['cargo run', 'cargo run --release'],
                'build': ['cargo build', 'cargo build --release'],
                'test': ['cargo test']
            },
            'go': {
                'run': ['go run main.go', 'go run .'],
                'build': ['go build', 'go build .'],
                'test': ['go test', 'go test ./...']
            }
        }

    def auto_learn_project_conventions(self, project_path: Optional[str] = None, force_refresh: bool = False) -> Dict[str, Any]:
        """
        Automatically learn project conventions from files and environment.
        
        Scans project directory to detect type, tools, commands, dependencies, and patterns.
        Results are cached and can be refreshed with force_refresh=True.
        
        Args:
            project_path: Project path to scan. If None, uses current working directory.
            force_refresh: Force re-learning even if conventions already cached.
            
        Returns:
            Dictionary with all discovered conventions
        """
        if not project_path:
            project_path = os.getcwd()

        logging.info(f"Learning project conventions at {project_path} (force_refresh={force_refresh})")

        conventions = {}
        conventions['environment'] = self._learn_environment()
        conventions['project_type'] = self._detect_project_type(project_path)
        conventions['commands'] = self._learn_commands(project_path, conventions['project_type'])
        conventions['tools'] = self._learn_tools(project_path)
        conventions['dependencies'] = self._learn_dependencies(project_path)
        conventions['deployment'] = self._learn_deployment_patterns(project_path)
        conventions['testing'] = self._learn_testing_patterns(project_path)

        self._store_conventions_as_memories(conventions)
        
        logging.info(f"Finished learning conventions: {conventions['project_type']}")
        return conventions

    def _learn_environment(self) -> Dict[str, str]:
        env_details = {
            'os': platform.system(),
            'os_version': platform.version(),
            'architecture': platform.machine(),
            'python_version': platform.python_version(),
            'shell': 'cmd.exe' if platform.system() == 'Windows' else 'bash',
            'path_separator': '\\' if platform.system() == 'Windows' else '/',
            'preferred_commands': self._get_os_preferred_commands()
        }

        tools_available = {}
        common_tools = ['node', 'npm', 'yarn', 'python', 'pip', 'cargo', 'go', 'git', 'docker']

        for tool in common_tools:
            try:
                import subprocess
                result = subprocess.run([tool, '--version'], capture_output=True, text=True, timeout=5)
                tools_available[tool] = result.returncode == 0
                if result.returncode == 0:
                    logging.debug(f"Tool '{tool}' is available")
            except Exception as e:
                tools_available[tool] = False
                logging.debug(f"Tool '{tool}' not available: {e}")

        env_details['tools_available'] = tools_available
        return env_details

    def _get_os_preferred_commands(self) -> Dict[str, str]:
        if platform.system() == 'Windows':
            return {
                'shell': 'cmd.exe',
                'python': 'python',
                'list_files': 'dir',
                'copy': 'copy',
                'move': 'move',
                'remove': 'del',
                'path_separator': '\\'
            }
        return {
            'shell': 'bash',
            'python': 'python3',
            'list_files': 'ls',
            'copy': 'cp',
            'move': 'mv',
            'remove': 'rm',
            'path_separator': '/'
        }

    def _detect_project_type(self, project_path: str) -> str:
        """
        Detect project type from configuration files.
        
        Checks for presence of common framework and language config files.
        Prioritizes more specific framework detections over generic language indicators.
        
        Args:
            project_path: Path to project
            
        Returns:
            Project type string (e.g., 'node_js', 'python', 'fastapi')
        """
        project_indicators = {
            'node_js': ['package.json', 'yarn.lock', 'npm-shrinkwrap.json'],
            'python': ['requirements.txt', 'setup.py', 'pyproject.toml', 'Pipfile'],
            'rust': ['Cargo.toml', 'Cargo.lock'],
            'go': ['go.mod', 'go.sum'],
            'java': ['pom.xml', 'build.gradle', 'settings.gradle'],
            'csharp': ['.csproj', '.sln'],
            'ruby': ['Gemfile', '.ruby-version'],
            'php': ['composer.json', 'composer.lock'],
            'kotlin': ['build.gradle.kts', 'pom.xml'],
            # Frameworks (higher priority)
            'django': ['manage.py', 'settings.py', 'wsgi.py'],
            'fastapi': ['main.py', 'app.py', 'requirements.txt'],
            'flask': ['app.py', 'wsgi.py', 'requirements.txt'],
            'nextjs': ['next.config.js', 'pages/', 'package.json'],
            'nuxt': ['nuxt.config.js', 'pages/', 'package.json'],
            'vite': ['vite.config.js', 'vite.config.ts', 'package.json'],
            'webpack': ['webpack.config.js', 'package.json'],
            'gatsby': ['gatsby-config.js', 'package.json'],
            'remix': ['remix.config.js', 'package.json'],
            'astro': ['astro.config.mjs', 'package.json'],
            'svelte': ['svelte.config.js', 'package.json'],
            'react': ['package.json'],  # Generic React
            'vue': ['vue.config.js', 'package.json'],
            'angular': ['angular.json', 'tsconfig.json'],
            'turbo': ['turbo.json', 'package.json'],
            'monorepo': ['pnpm-workspace.yaml', 'lerna.json', 'workspaces'],
            'mcp_server': ['mcp_server.py', 'mcp_server_enhanced.py', 'launcher.py'],
            'docker': ['Dockerfile', 'docker-compose.yml'],
        }

        detected_types = []
        for project_type, indicators in project_indicators.items():
            for indicator in indicators:
                check_path = os.path.join(project_path, indicator)
                if os.path.exists(check_path) or os.path.isdir(check_path):
                    detected_types.append(project_type)
                    logging.debug(f"Detected {project_type} from {indicator}")
                    break

        # Priority ordering: frameworks > specialized > generic
        priority_order = [
            'mcp_server', 'nextjs', 'nuxt', 'django', 'fastapi', 'flask', 'remix',
            'astro', 'vite', 'webpack', 'gatsby', 'angular', 'svelte', 'react', 'vue',
            'turbo', 'monorepo', 'docker',
            'node_js', 'python', 'rust', 'go', 'java', 'csharp', 'ruby', 'php', 'kotlin'
        ]

        for project_type in priority_order:
            if project_type in detected_types:
                logging.info(f"Detected project type: {project_type}")
                return project_type

        if detected_types:
            logging.warning(f"Detected multiple types but none in priority: {detected_types}")
            return detected_types[0]
            
        logging.warning(f"Could not detect project type at {project_path}")
        return 'unknown'

    def _learn_commands(self, project_path: str, project_type: str) -> Dict[str, List[str]]:
        commands = {}

        if project_type == 'node_js':
            package_json = os.path.join(project_path, 'package.json')
            if os.path.exists(package_json):
                try:
                    with open(package_json, 'r') as f:
                        data = json.load(f)
                        scripts = data.get('scripts', {})
                        for script_name, _ in scripts.items():
                            commands[script_name] = [f'npm run {script_name}']
                except Exception:
                    pass

        command_files = {
            'Makefile': self._parse_makefile,
            'package.json': self._parse_package_json,
            'pyproject.toml': self._parse_pyproject_toml,
            'Cargo.toml': self._parse_cargo_toml
        }

        for filename, parser in command_files.items():
            filepath = os.path.join(project_path, filename)
            if os.path.exists(filepath):
                try:
                    file_commands = parser(filepath)
                    commands.update(file_commands)
                except Exception as e:
                    self.logger.warning(f"Failed to parse {filename}: {e}")

        if project_type in self.command_patterns:
            default_commands = self.command_patterns[project_type]
            for cmd_type, cmd_list in default_commands.items():
                if cmd_type not in commands:
                    commands[cmd_type] = cmd_list

        return commands

    def _parse_package_json(self, filepath: str) -> Dict[str, List[str]]:
        commands = {}
        try:
            with open(filepath, 'r') as f:
                data = json.load(f)
                scripts = data.get('scripts', {})
                for script_name, _ in scripts.items():
                    commands[script_name] = [f'npm run {script_name}']
        except Exception:
            pass
        return commands

    def _parse_makefile(self, filepath: str) -> Dict[str, List[str]]:
        """
        Parse Makefile to extract targets as commands.
        
        Extracts all valid make targets (excludes special targets starting with .).
        
        Args:
            filepath: Path to Makefile
            
        Returns:
            Dictionary mapping target names to make commands
        """
        commands = {}
        try:
            with open(filepath, 'r') as f:
                content = f.read()
                # Match targets at start of line, followed by colon, excluding .targets
                targets = re.findall(r'^([a-zA-Z][a-zA-Z0-9_-]*):(?!.*=)', content, re.MULTILINE)
                for target in targets:
                    if not target.startswith('.'):  # Skip .PHONY, .DEFAULT, etc.
                        commands[target] = [f'make {target}']
                        logging.debug(f"Extracted make target: {target}")
        except Exception as e:
            logging.warning(f"Failed to parse Makefile: {e}")
        return commands

    def _parse_pyproject_toml(self, filepath: str) -> Dict[str, List[str]]:
        commands = {}
        try:
            with open(filepath, 'r') as f:
                content = f.read()
                if 'poetry' in content:
                    commands['install'] = ['poetry install']
                    commands['run'] = ['poetry run python main.py']
        except Exception:
            pass
        return commands

    def _parse_cargo_toml(self, filepath: str) -> Dict[str, List[str]]:
        return {
            'run': ['cargo run'],
            'build': ['cargo build'],
            'test': ['cargo test']
        }

    def _learn_tools(self, project_path: str) -> Dict[str, Any]:
        """
        Detect development tools and their configurations.
        
        Identifies IDEs, linters, CI/CD systems, and other development tools.
        
        Args:
            project_path: Path to project
            
        Returns:
            Dictionary of detected tools and configurations
        """
        tools = {}

        # IDE/Editor configurations
        ide_configs = {
            '.vscode': 'Visual Studio Code',
            '.idea': 'IntelliJ IDEA',
            '.vim': 'Vim',
            '.emacs': 'Emacs',
            '.neovim': 'Neovim',
            '.sublime': 'Sublime Text',
        }

        for config_dir, tool_name in ide_configs.items():
            if os.path.exists(os.path.join(project_path, config_dir)):
                tools['editor'] = tool_name
                logging.debug(f"Detected editor: {tool_name}")
                break

        # Linting and formatting tools
        linting_configs = {
            '.eslintrc*': 'ESLint',
            '.prettierrc*': 'Prettier',
            'pyproject.toml': 'Black/Ruff',
            '.flake8': 'Flake8',
            'rustfmt.toml': 'Rustfmt',
            '.stylelintrc*': 'Stylelint',
            '.pylintrc': 'Pylint',
            'biome.json': 'Biome',
            'deno.json': 'Deno',
        }

        for pattern, tool in linting_configs.items():
            files = list(Path(project_path).glob(pattern))
            if files:
                if 'linting' not in tools:
                    tools['linting'] = []
                if tool not in tools['linting']:
                    tools['linting'].append(tool)
                    logging.debug(f"Detected linting tool: {tool}")

        # CI/CD systems
        ci_indicators = {
            '.github/workflows': 'GitHub Actions',
            '.gitlab-ci.yml': 'GitLab CI',
            'Jenkinsfile': 'Jenkins',
            '.circleci': 'CircleCI',
            '.travis.yml': 'Travis CI',
            'azure-pipelines.yml': 'Azure Pipelines',
            '.drone.yml': 'Drone CI',
        }

        for indicator, ci_tool in ci_indicators.items():
            if os.path.exists(os.path.join(project_path, indicator)):
                tools['ci_cd'] = ci_tool
                logging.debug(f"Detected CI/CD: {ci_tool}")
                break

        # Version control tools
        vcs_indicators = {
            '.git': 'Git',
            '.hg': 'Mercurial',
            '.svn': 'SVN',
        }

        for indicator, vcs in vcs_indicators.items():
            if os.path.exists(os.path.join(project_path, indicator)):
                tools['vcs'] = vcs
                logging.debug(f"Detected VCS: {vcs}")
                break

        # Container tools
        if os.path.exists(os.path.join(project_path, 'Dockerfile')):
            tools['containerization'] = 'Docker'
            logging.debug("Detected Docker")
        if os.path.exists(os.path.join(project_path, 'docker-compose.yml')):
            tools['orchestration'] = 'Docker Compose'
            logging.debug("Detected Docker Compose")

        return tools

    def _learn_dependencies(self, project_path: str) -> Dict[str, Any]:
        """
        Detect package managers and dependency configuration.
        
        Args:
            project_path: Path to project
            
        Returns:
            Dictionary with package manager info and lock files
        """
        deps = {}

        # Dependency file -> package manager mapping
        dep_files = {
            'package.json': 'npm/yarn',
            'requirements.txt': 'pip',
            'requirements-dev.txt': 'pip (with dev)',
            'Pipfile': 'pipenv',
            'Pipfile.lock': 'pipenv',
            'pyproject.toml': 'poetry/pip',
            'poetry.lock': 'poetry',
            'Cargo.toml': 'cargo',
            'Cargo.lock': 'cargo',
            'go.mod': 'go modules',
            'go.sum': 'go modules',
            'pom.xml': 'maven',
            'build.gradle': 'gradle',
            'build.gradle.kts': 'kotlin gradle',
            'settings.gradle': 'gradle',
            'Gemfile': 'bundler',
            'Gemfile.lock': 'bundler',
            'composer.json': 'composer',
            'composer.lock': 'composer',
            'package-lock.json': 'npm',
            'yarn.lock': 'yarn',
            'pnpm-lock.yaml': 'pnpm',
            'bun.lockb': 'bun',
        }

        for filename, manager in dep_files.items():
            if os.path.exists(os.path.join(project_path, filename)):
                if 'lock' in filename.lower():
                    deps['lock_file'] = filename
                    deps['lock_manager'] = manager
                    logging.debug(f"Found lock file: {filename} ({manager})")
                else:
                    deps['package_manager'] = manager
                    deps['dependency_file'] = filename
                    logging.debug(f"Found dependency file: {filename} ({manager})")

        return deps

    def _learn_deployment_patterns(self, project_path: str) -> Dict[str, Any]:
        deployment = {}

        if os.path.exists(os.path.join(project_path, 'Dockerfile')):
            deployment['containerization'] = 'Docker'

        if os.path.exists(os.path.join(project_path, 'docker-compose.yml')):
            deployment['orchestration'] = 'Docker Compose'

        build_files = {
            'webpack.config.js': 'Webpack',
            'vite.config.js': 'Vite',
            'rollup.config.js': 'Rollup',
            'build.sh': 'Shell script',
            'build.bat': 'Batch script'
        }

        for build_file, build_tool in build_files.items():
            if os.path.exists(os.path.join(project_path, build_file)):
                deployment['build_tool'] = build_tool
                break

        deploy_configs = {
            'vercel.json': 'Vercel',
            'netlify.toml': 'Netlify',
            'Procfile': 'Heroku',
            'app.yaml': 'Google App Engine'
        }

        for config_file, platform_name in deploy_configs.items():
            if os.path.exists(os.path.join(project_path, config_file)):
                deployment['platform'] = platform_name
                break

        return deployment

    def _learn_testing_patterns(self, project_path: str) -> Dict[str, Any]:
        """
        Detect testing frameworks and patterns.
        
        Args:
            project_path: Path to project
            
        Returns:
            Dictionary with testing framework and commands
        """
        testing = {}

        test_indicators = {
            'jest.config.js': 'Jest',
            'jest.config.ts': 'Jest',
            'vitest.config.js': 'Vitest',
            'vitest.config.ts': 'Vitest',
            'playwright.config.js': 'Playwright',
            'cypress.config.js': 'Cypress',
            'pytest.ini': 'pytest',
            'pyproject.toml': 'pytest (if Python)',
            'tox.ini': 'tox',
            'test_*.py': 'pytest',
            '*_test.py': 'pytest',
            'tests/': 'Generic test directory',
            '__tests__/': 'Jest tests',
            'spec/': 'Spec tests',
            '.rspec': 'RSpec',
            'karma.conf.js': 'Karma',
            'mocha.opts': 'Mocha',
        }

        for indicator, framework in test_indicators.items():
            if '*' in indicator:
                # Glob pattern
                files = list(Path(project_path).glob(indicator))
                if files:
                    testing['framework'] = framework
                    logging.debug(f"Detected test framework: {framework}")
                    break
            else:
                # Direct path check
                if os.path.exists(os.path.join(project_path, indicator)):
                    testing['framework'] = framework
                    logging.debug(f"Detected test framework: {framework}")
                    break

        # Extract test commands from package.json if available
        package_json = os.path.join(project_path, 'package.json')
        if os.path.exists(package_json):
            try:
                with open(package_json, 'r') as f:
                    data = json.load(f)
                    scripts = data.get('scripts', {})
                    if 'test' in scripts:
                        testing['test_command'] = 'npm test'
                        logging.debug("Found npm test script")
                    if 'test:unit' in scripts:
                        testing['unit_test_command'] = 'npm run test:unit'
                    if 'test:e2e' in scripts:
                        testing['e2e_test_command'] = 'npm run test:e2e'
            except Exception as e:
                logging.debug(f"Failed to parse package.json for test scripts: {e}")

        # Check for pytest configuration
        if os.path.exists(os.path.join(project_path, 'pytest.ini')):
            testing['test_command'] = 'pytest'
        elif os.path.exists(os.path.join(project_path, 'pyproject.toml')):
            try:
                with open(os.path.join(project_path, 'pyproject.toml'), 'r') as f:
                    content = f.read()
                    if '[tool.pytest' in content:
                        testing['test_command'] = 'pytest'
            except Exception:
                pass

        return testing

    def _store_conventions_as_memories(self, conventions: Dict[str, Any]):
        """Store learned conventions as project memories."""
        if not self.memory_manager.current_project_id:
            return

        env_details = conventions.get('environment', {})
        if env_details:
            env_content = f"""Project Environment Configuration:

Operating System: {env_details.get('os')} {env_details.get('os_version')}
Architecture: {env_details.get('architecture')}
Shell: {env_details.get('shell')}
Python Version: {env_details.get('python_version')}

Preferred Commands for {env_details.get('os')}:
{json.dumps(env_details.get('preferred_commands', {}), indent=2)}

Available Tools:
{json.dumps(env_details.get('tools_available', {}), indent=2)}
"""

            self.memory_manager.add_context_memory(
                content=env_content,
                memory_type="environment",
                importance=0.9,
                tags=["environment", "os", "tools", "commands"]
            )

        project_type = conventions.get('project_type')
        commands = conventions.get('commands', {})
        if project_type and commands:
            cmd_content = f"""Project Type: {project_type}

Recommended Commands:
{json.dumps(commands, indent=2)}

IMPORTANT: Always use these project-specific commands instead of generic alternatives.
For example, use 'npm run dev' instead of 'node server.js' for this project.
"""

            self.memory_manager.add_context_memory(
                content=cmd_content,
                memory_type="commands",
                importance=0.95,
                tags=["commands", "project-type", project_type, "scripts"]
            )

        tools = conventions.get('tools', {})
        deps = conventions.get('dependencies', {})
        if tools or deps:
            tools_content = f"""Development Tools & Dependencies:

Tools:
{json.dumps(tools, indent=2)}

Dependencies:
{json.dumps(deps, indent=2)}

Use the specified package manager and follow established patterns for this project.
"""

            self.memory_manager.add_context_memory(
                content=tools_content,
                memory_type="tools",
                importance=0.8,
                tags=["tools", "dependencies", "setup"]
            )

        deployment = conventions.get('deployment', {})
        if deployment:
            deploy_content = f"""Deployment Configuration:

{json.dumps(deployment, indent=2)}

Follow these deployment patterns for consistency with project setup.
"""

            self.memory_manager.add_context_memory(
                content=deploy_content,
                memory_type="deployment",
                importance=0.7,
                tags=["deployment", "build", "setup"]
            )

        testing = conventions.get('testing', {})
        if testing:
            test_content = f"""Testing Configuration:

{json.dumps(testing, indent=2)}

Use the specified testing framework and commands for this project.
"""

            self.memory_manager.add_context_memory(
                content=test_content,
                memory_type="testing",
                importance=0.7,
                tags=["testing", "qa", "commands"]
            )

    def get_project_conventions_summary(self) -> str:
        """Get a formatted summary of project conventions for AI context."""
        if not self.memory_manager.current_project_id:
            return "No active project for convention lookup."

        convention_memories = []
        for conv_type in self.convention_types.keys():
            memories = self.db.search_memories(conv_type, self.memory_manager.current_project_id, limit=2)
            convention_memories.extend(memories)

        if not convention_memories:
            return "No project conventions learned yet. Use auto_learn_project_conventions() to analyze the project."

        summary_parts = ["## Project Conventions & Environment"]

        for memory in convention_memories:
            memory_type = memory['type']
            title = memory['title']
            content_preview = memory['content'][:200] + "..." if len(memory['content']) > 200 else memory['content']

            summary_parts.append(f"\n### {memory_type.title()}: {title}")
            summary_parts.append(content_preview)

        summary_parts.append("\nIMPORTANT: Always follow these project-specific conventions and commands!")

        return "\n".join(summary_parts)

    def suggest_correct_command(self, user_command: str) -> Optional[str]:
        """Suggest correct project-specific command based on user input."""
        if not self.memory_manager.current_project_id:
            return None

        command_memories = self.db.search_memories("commands", self.memory_manager.current_project_id, limit=5)

        if not command_memories:
            return None

        all_commands = {}
        for memory in command_memories:
            try:
                content = memory['content']
                if '{' in content and '}' in content:
                    start = content.find('{')
                    end = content.rfind('}') + 1
                    json_part = content[start:end]
                    commands_data = json.loads(json_part)
                    all_commands.update(commands_data)
            except Exception:
                continue

        suggestions = {}
        command_mappings = {
            'node': ['npm run dev', 'npm start'],
            'python app.py': ['python main.py', 'uvicorn main:app'],
            'python server.py': ['python main.py', 'npm run dev'],
            'start': ['npm run dev', 'npm start'],
            'dev': ['npm run dev'],
            'build': ['npm run build', 'cargo build'],
            'test': ['npm test', 'pytest', 'cargo test']
        }

        user_lower = user_command.lower()
        for pattern, suggestions_list in command_mappings.items():
            if pattern in user_lower:
                for cmd_type, cmd_list in all_commands.items():
                    if any(suggestion in cmd_list for suggestion in suggestions_list):
                        return f"Use '{cmd_list[0]}' instead of '{user_command}' for this project"

        return None
