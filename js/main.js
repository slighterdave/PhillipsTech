/* =========================================================
   PhillipsTech — Main JavaScript
   ========================================================= */

(function () {
  'use strict';

  /* ── Navbar: scroll effect + active link ── */
  const navbar   = document.getElementById('navbar');
  const sections = document.querySelectorAll('section[id]');
  const navAnchors = document.querySelectorAll('.nav-links a[href^="#"]');

  function onScroll () {
    /* Sticky style */
    if (window.scrollY > 60) {
      navbar.classList.add('scrolled');
    } else {
      navbar.classList.remove('scrolled');
    }

    /* Back-to-top button */
    const btt = document.getElementById('back-to-top');
    if (window.scrollY > 400) {
      btt.classList.add('visible');
    } else {
      btt.classList.remove('visible');
    }

    /* Active nav link */
    let current = '';
    sections.forEach(function (sec) {
      const top = sec.offsetTop - 100;
      if (window.scrollY >= top) current = sec.getAttribute('id');
    });
    navAnchors.forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('href') === '#' + current);
    });

    /* Parallax layers */
    requestAnimationFrame(updateParallax);

    /* Stats counter (trigger once) */
    triggerCounters();

    /* Scroll reveal */
    revealElements();
  }

  window.addEventListener('scroll', onScroll, { passive: true });

  /* ── Hamburger / Mobile Menu ── */
  const hamburger = document.getElementById('hamburger');
  const navLinks  = document.getElementById('nav-links');

  hamburger.addEventListener('click', function () {
    const open = navLinks.classList.toggle('open');
    hamburger.setAttribute('aria-expanded', open);
    // Animate the three bars
    const bars = hamburger.querySelectorAll('span');
    if (open) {
      bars[0].style.transform = 'translateY(7px) rotate(45deg)';
      bars[1].style.opacity   = '0';
      bars[2].style.transform = 'translateY(-7px) rotate(-45deg)';
    } else {
      bars[0].style.transform = '';
      bars[1].style.opacity   = '';
      bars[2].style.transform = '';
    }
  });

  // Close menu when a link is clicked
  navLinks.querySelectorAll('a').forEach(function (a) {
    a.addEventListener('click', function () {
      navLinks.classList.remove('open');
      hamburger.setAttribute('aria-expanded', 'false');
      const bars = hamburger.querySelectorAll('span');
      bars[0].style.transform = '';
      bars[1].style.opacity   = '';
      bars[2].style.transform = '';
    });
  });

  /* ── Parallax ── */
  const heroParallax    = document.getElementById('hero-parallax');
  const servicesParallax = document.getElementById('services-parallax');
  const aboutParallax   = document.getElementById('about-parallax');

  function updateParallax () {
    const scrollY = window.scrollY;

    if (heroParallax) {
      heroParallax.style.transform = 'translateY(' + (scrollY * 0.35) + 'px)';
    }

    if (servicesParallax) {
      const servicesTop = servicesParallax.closest('section').offsetTop;
      const rel = scrollY - servicesTop;
      servicesParallax.style.transform = 'translateY(' + (rel * 0.2) + 'px)';
    }

    if (aboutParallax) {
      const aboutTop = aboutParallax.closest('section').offsetTop;
      const rel = scrollY - aboutTop;
      aboutParallax.style.transform = 'translateY(' + (rel * 0.25) + 'px)';
    }
  }

  /* ── Animated Stats Counter ── */
  let countersTriggered = false;

  function triggerCounters () {
    if (countersTriggered) return;
    const strip = document.querySelector('.stats-strip');
    if (!strip) return;
    const rect = strip.getBoundingClientRect();
    if (rect.top < window.innerHeight - 80) {
      countersTriggered = true;
      document.querySelectorAll('.stat-number').forEach(function (el) {
        animateCount(el, parseInt(el.dataset.target, 10), 1800);
      });
    }
  }

  function animateCount (el, target, duration) {
    const start     = performance.now();
    const startVal  = 0;

    function step (now) {
      const elapsed  = now - start;
      const progress = Math.min(elapsed / duration, 1);
      // Ease-out cubic
      const eased    = 1 - Math.pow(1 - progress, 3);
      el.textContent = Math.round(startVal + (target - startVal) * eased);
      if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  /* ── Scroll Reveal ── */
  function revealElements () {
    document.querySelectorAll('.reveal:not(.revealed)').forEach(function (el) {
      const rect = el.getBoundingClientRect();
      if (rect.top < window.innerHeight - 60) {
        el.classList.add('revealed');
      }
    });
  }

  /* Add reveal classes to key elements after DOM load */
  function initReveal () {
    const targets = [
      { sel: '.service-card',       delay: true },
      { sel: '.testimonial-card',   delay: true },
      { sel: '.stat',               delay: true },
      { sel: '.contact-info',       delay: false },
      { sel: '.contact-form-wrap',  delay: false },
      { sel: '.section-header',     delay: false },
      { sel: '.about-image-wrap',   delay: false },
      { sel: '.about-content',      delay: false },
    ];
    targets.forEach(function (t) {
      document.querySelectorAll(t.sel).forEach(function (el, i) {
        el.classList.add('reveal');
        if (t.delay) {
          const d = Math.min(i + 1, 5);
          el.classList.add('reveal-delay-' + d);
        }
      });
    });
    // Run once immediately for elements already in view
    revealElements();
  }

  /* ── Smooth Scroll for anchor links ── */
  document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
    anchor.addEventListener('click', function (e) {
      const targetId = this.getAttribute('href').slice(1);
      if (!targetId) return;
      const target = document.getElementById(targetId);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth' });
      }
    });
  });

  /* ── Contact Form Validation & Submit ── */
  const form        = document.getElementById('contact-form');
  const formSuccess = document.getElementById('form-success');

  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (validateForm()) {
        submitForm();
      }
    });

    // Live validation — clear error on input
    ['name', 'email', 'message'].forEach(function (id) {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', function () {
          clearError(id);
        });
      }
    });
  }

  function validateForm () {
    let valid = true;

    const name    = document.getElementById('name');
    const email   = document.getElementById('email');
    const message = document.getElementById('message');

    if (!name.value.trim()) {
      showError('name', 'Please enter your full name.');
      valid = false;
    } else {
      clearError('name');
    }

    if (!email.value.trim()) {
      showError('email', 'Please enter your email address.');
      valid = false;
    } else if (!isValidEmail(email.value.trim())) {
      showError('email', 'Please enter a valid email address.');
      valid = false;
    } else {
      clearError('email');
    }

    if (!message.value.trim()) {
      showError('message', 'Please enter a message.');
      valid = false;
    } else {
      clearError('message');
    }

    return valid;
  }

  function showError (fieldId, msg) {
    const field = document.getElementById(fieldId);
    const err   = document.getElementById('error-' + fieldId);
    if (field) field.classList.add('invalid');
    if (err)   err.textContent = msg;
  }

  function clearError (fieldId) {
    const field = document.getElementById(fieldId);
    const err   = document.getElementById('error-' + fieldId);
    if (field) field.classList.remove('invalid');
    if (err)   err.textContent = '';
  }

  function isValidEmail (email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function submitForm () {
    const btn   = form.querySelector('.btn-submit');
    const label = btn.querySelector('.btn-label');

    // Loading state
    btn.disabled      = true;
    label.textContent = 'Sending…';

    var name    = document.getElementById('name').value.trim();
    var email   = document.getElementById('email').value.trim();
    var message = document.getElementById('message').value.trim();

    fetch('/api/contact', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name: name, email: email, message: message }),
    })
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (result) {
        btn.disabled      = false;
        label.textContent = 'Send Message';
        if (result.ok) {
          form.reset();
          formSuccess.classList.add('visible');
          formSuccess.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          setTimeout(function () { formSuccess.classList.remove('visible'); }, 8000);
        } else {
          showError('message', result.data.error || 'Submission failed. Please try again.');
        }
      })
      .catch(function () {
        btn.disabled      = false;
        label.textContent = 'Send Message';
        showError('message', 'Unable to send message. Please try again later.');
      });
  }

  /* ── Footer Year ── */
  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  /* ── Init on DOM Ready ── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initReveal);
  } else {
    initReveal();
  }

  // Kick off scroll handler once
  onScroll();
}());
