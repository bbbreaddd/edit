/**
 *  Copyright (c) 2025 taskylizard. Apache License 2.0.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *  http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */

import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import {
  afterSearchNavigation,
  beforeSearchNavigation
} from '../search/resultNavigation'
import { loadProgress } from './composables/nprogress'
import { pendingScrollQuery } from './composables/searchScroll'
import Layout from './Layout.vue'
import Post from './PostLayout.vue'
import { useThemeHandler } from './themes/themeHandler'

import './style.scss'
import 'virtual:uno.css'

import FloatingVue from 'floating-vue'
import Feedback from './components/Feedback.vue'

import 'floating-vue/dist/style.css'

import CriticalBadge from './components/CriticalBadge.vue'
import GradientCard from './components/GradientCard.vue'
import LinkCard from './components/LinkCard.vue'
import LinkInline from './components/LinkInline.vue'
import Tag from './components/Tag.vue'
import Tooltip from './components/Tooltip.vue'
import VideoFrame from './components/VideoFrame.vue'

const removalDateFormat = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'long',
  timeZone: 'UTC'
})

function removedDateTooltip(date: string): string {
  const removedAt = new Date(`${date}T00:00:00Z`)
  const now = new Date()
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  )
  const days = Math.round((today - removedAt.getTime()) / 86_400_000)
  const relative =
    days === 0
      ? 'Today'
      : days > 0
        ? `${days} day${days === 1 ? '' : 's'} ago`
        : `In ${-days} day${days === -1 ? '' : 's'}`

  return `<strong>${relative}</strong><br><time datetime="${date}">${removalDateFormat.format(removedAt)}</time>`
}

const applySeasonalBranding = () => {
  const month = new Date().getMonth()
  const isJune = month === 5
  const isOctober = month === 9

  document.documentElement.classList.toggle('june', isJune)
  document.documentElement.classList.toggle('halloween', isOctober)

  const favicon = document.querySelector<HTMLLinkElement>("link[rel='icon']")
  if (favicon) {
    favicon.href = isJune
      ? '/june_icon.webp'
      : isOctober
        ? '/hall.png'
        : '/fmhy.ico'
    favicon.type = isJune
      ? 'image/webp'
      : isOctober
        ? 'image/png'
        : 'image/x-icon'
  }

  const alternateIcon = document.querySelector<HTMLLinkElement>(
    "link[rel='alternate icon']"
  )
  if (alternateIcon) {
    alternateIcon.href = isOctober ? '/hall.png' : '/pwa_icon.png'
  }

  const appleIcon = document.querySelector<HTMLLinkElement>(
    "link[rel='apple-touch-icon']"
  )
  if (appleIcon) {
    appleIcon.href = isOctober ? '/hall.png' : '/pwa_icon.png'
  }

  const themeColor = document.querySelector<HTMLMetaElement>(
    "meta[name='theme-color']"
  )
  if (themeColor) {
    themeColor.content = isOctober ? '#EA580C' : '#7bc5e4'
  }
}

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ router, app }) {
    app.use(FloatingVue)
    app.component('GradientCard', GradientCard)
    app.component('VideoFrame', VideoFrame)
    app.component('LinkCard', LinkCard)
    app.component('LinkInline', LinkInline)
    app.component('Tag', Tag)
    app.component('Post', Post)
    app.component('Feedback', Feedback)
    app.component('CriticalBadge', CriticalBadge)
    app.component('Tooltip', Tooltip)
    app.config.globalProperties.$removedDateTooltip = removedDateTooltip
    app.config.globalProperties.$removedDateTriggers =
      typeof window !== 'undefined' &&
      !window.matchMedia('(hover: hover)').matches
        ? ['click']
        : ['hover', 'focus']
    loadProgress(router)

    if (typeof window !== 'undefined') {
      applySeasonalBranding()
      requestAnimationFrame(applySeasonalBranding)

      const originalBefore = router.onBeforeRouteChange
      const originalAfter = router.onAfterRouteChanged

      router.onBeforeRouteChange = (to) => {
        beforeSearchNavigation(to)

        originalBefore?.(to)
      }

      router.onAfterRouteChanged = (to) => {
        const hasPendingSearch = !!pendingScrollQuery.value
        originalAfter?.(to)

        requestAnimationFrame(applySeasonalBranding)

        afterSearchNavigation(hasPendingSearch)
      }
    }

    // Initialize theme handler
    useThemeHandler()
  }
} satisfies Theme
